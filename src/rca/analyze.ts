// The RCA brain: turns raw spans/logs into a ranked list of likely root causes.
// See docs/03-rca-engine.md for the walkthrough of every step in this file.
import { DATABASES, ENTRY_SERVICE, SERVICES } from "../shared/config";
import type { Span } from "./otlp";
import type { Store } from "./store";
import { clamp01, mad, mean, median, percentile, round, sum, unionLength } from "./stats";

// ---------------------------------------------------------------------------------------------
// 1. Spans -> per-service "requests" (one request = one SERVER span in one service)
// ---------------------------------------------------------------------------------------------
export interface Req {
  traceId: string;
  spanId: string;
  service: string;
  start: number;
  end: number;
  dur: number; // total time, including time waiting on downstream services
  self: number; // dur minus time covered by downstream CLIENT spans = time spent in THIS service
  error: boolean;
  origin: boolean; // error that did NOT come from a downstream dependency
}

interface Edge {
  from: string;
  to: string;
  start: number;
  dur: number;
  error: boolean;
}

interface TraceDerived {
  nSpans: number;
  reqs: Req[];
  edges: Edge[];
}

const derivedCache = new Map<string, TraceDerived>();

const DB_NAMES: Record<string, string> = { postgresql: "postgres", redis: "redis" };

/** A CLIENT span that is a real database QUERY (not a connection-setup span) -> the database's node name. */
function dbQueryTarget(s: Span): string | undefined {
  if (s.kind !== "client") return undefined;
  const sys = s.attrs["db.system"];
  if (typeof sys !== "string" || /connect/i.test(s.name)) return undefined;
  return DB_NAMES[sys] ?? sys;
}

function derive(traceId: string, spans: Span[]): TraceDerived {
  const hit = derivedCache.get(traceId);
  if (hit && hit.nSpans === spans.length) return hit; // spans of one trace arrive from several services; recompute only when new ones land

  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, Span[]>();
  for (const s of spans) {
    if (!s.parentId) continue;
    const l = children.get(s.parentId);
    if (l) l.push(s);
    else children.set(s.parentId, [s]);
  }

  const reqs: Req[] = [];
  const edges: Edge[] = [];
  for (const s of spans) {
    if (s.kind !== "server") continue;
    // Waiting = calls to other services and database QUERIES. Connection setup / pool-wait spans are NOT
    // subtracted: pool exhaustion is the service's own problem and must show up as its self time.
    const clients = (children.get(s.spanId) ?? []).filter((c) => c.kind === "client" && !(c.attrs["db.system"] && /connect/i.test(c.name)));
    const waiting = unionLength(clients.map((c) => [c.start, c.end]), s.start, s.end);
    reqs.push({
      traceId,
      spanId: s.spanId,
      service: s.service,
      start: s.start,
      end: s.end,
      dur: s.dur,
      self: Math.max(0, s.dur - waiting),
      error: s.error,
      origin: s.error && !clients.some((c) => c.error),
    });
    const parent = s.parentId ? byId.get(s.parentId) : undefined;
    if (parent && parent.kind === "client" && parent.service !== s.service) {
      edges.push({ from: parent.service, to: s.service, start: s.start, dur: s.dur, error: s.error });
    }
  }

  // Databases have no SERVER span of their own, so each query's CLIENT span stands in for it: the whole
  // client-side duration is the database's "self time", and the call forms an edge service -> database.
  for (const s of spans) {
    const db = dbQueryTarget(s);
    if (!db) continue;
    reqs.push({ traceId, spanId: s.spanId, service: db, start: s.start, end: s.end, dur: s.dur, self: s.dur, error: s.error, origin: s.error });
    edges.push({ from: s.service, to: db, start: s.start, dur: s.dur, error: s.error });
  }

  const d = { nSpans: spans.length, reqs, edges };
  derivedCache.set(traceId, d);
  return d;
}

function collect(store: Store, from: number, to: number) {
  const reqs: Req[] = [];
  const edges: Edge[] = [];
  const byTrace = new Map<string, Req[]>();
  for (const [id, spans] of store.traces) {
    const d = derive(id, spans);
    const inRange = d.reqs.filter((r) => r.start >= from && r.start <= to);
    if (inRange.length) {
      reqs.push(...inRange);
      byTrace.set(id, d.reqs);
    }
    edges.push(...d.edges.filter((e) => e.start >= from && e.start <= to));
  }
  for (const id of derivedCache.keys()) if (!store.traces.has(id)) derivedCache.delete(id);
  return { reqs, edges, byTrace };
}

// ---------------------------------------------------------------------------------------------
// 2. Anomaly detection + root-cause scoring
// ---------------------------------------------------------------------------------------------
export interface AnalysisOptions {
  windowMs: number; // "now": the window we are diagnosing
  baselineMs: number; // "normal": the period right before it
  now?: number;
}

export const WEIGHTS = { selfTime: 0.35, errors: 0.25, criticalPath: 0.2, precedence: 0.1, leaf: 0.1 };
const BUCKET_MS = 1000;
const MIN_REQS = 5;

const bucketOf = (t: number) => Math.floor(t / BUCKET_MS);

function robustZ(value: number, baseline: number[], floorAbs: number): { z: number; med: number } {
  const med = median(baseline);
  const scale = Math.max(mad(baseline), 0.15 * med, floorAbs);
  return { z: (value - med) / scale, med };
}

export interface ServiceReport {
  name: string;
  requests: number;
  baselineRequests: number;
  selfMs: { baseline: number; current: number; z: number };
  /** Mean total request time (own work + waiting on dependencies). total - self = time spent waiting. */
  totalMs: { baseline: number; current: number };
  durP95: { baseline: number; current: number };
  errorRate: { baseline: number; current: number };
  originErrorRate: { baseline: number; current: number };
  scores: { selfTime: number; errors: number; criticalPath: number; precedence: number; leaf: number };
  firstAnomalyAt: number | null;
  anomalous: boolean;
  score: number;
  role: "root-cause suspect" | "affected (inherited)" | "healthy" | "no data";
  evidence: string[];
}

export function analyze(store: Store, opts: AnalysisOptions) {
  const now = opts.now ?? Date.now();
  const curFrom = now - opts.windowMs;
  const baseFrom = curFrom - opts.baselineMs;
  const { reqs, edges, byTrace } = collect(store, baseFrom, now);

  const cur = reqs.filter((r) => r.start >= curFrom);
  const base = reqs.filter((r) => r.start < curFrom);

  // ---- dependency graph (built purely from parent->child spans that cross a service boundary)
  const edgeAgg = new Map<string, { from: string; to: string; calls: number; errors: number; durs: number[] }>();
  for (const e of edges) {
    if (e.start < curFrom) continue;
    const k = `${e.from}->${e.to}`;
    const a = edgeAgg.get(k) ?? { from: e.from, to: e.to, calls: 0, errors: 0, durs: [] };
    a.calls++;
    if (e.error) a.errors++;
    a.durs.push(e.dur);
    edgeAgg.set(k, a);
  }
  const graphEdges = [...edgeAgg.values()].map((a) => ({
    from: a.from,
    to: a.to,
    calls: a.calls,
    errorRate: round(a.errors / a.calls, 3),
    p95Ms: round(percentile(a.durs, 95), 1),
  }));
  const downstream = new Map<string, string[]>();
  for (const e of graphEdges) downstream.set(e.from, [...(downstream.get(e.from) ?? []), e.to]);

  // ---- entry-point traces: what the user actually experienced
  const entryCur = cur.filter((r) => r.service === ENTRY_SERVICE);
  const entryBase = base.filter((r) => r.service === ENTRY_SERVICE);
  const entryBaseP95 = percentile(entryBase.map((r) => r.dur), 95);
  // "Slow" is judged against the baseline MEDIAN, not its p95: the median stays honest even if the
  // baseline window is partly contaminated by the start of the incident.
  const entryBaseMed = median(entryBase.map((r) => r.dur));
  const slowThreshold = Math.max(entryBaseMed * 1.6, entryBaseMed + 15);
  const slow = entryBase.length >= MIN_REQS ? entryCur.filter((r) => r.dur >= slowThreshold) : [];
  const failed = entryCur.filter((r) => r.error);

  const shareOf = (trace: Req[], entryDur: number) => {
    const m = new Map<string, number>();
    for (const r of trace) m.set(r.service, (m.get(r.service) ?? 0) + r.self / entryDur);
    return m;
  };
  const baseShare = new Map<string, number>();
  for (const e of entryBase.slice(-300)) {
    for (const [s, v] of shareOf(byTrace.get(e.traceId) ?? [], e.dur)) baseShare.set(s, (baseShare.get(s) ?? 0) + v / Math.min(300, entryBase.length));
  }
  const slowShare = new Map<string, number>();
  for (const e of slow) {
    for (const [s, v] of shareOf(byTrace.get(e.traceId) ?? [], e.dur)) slowShare.set(s, (slowShare.get(s) ?? 0) + v / slow.length);
  }
  const failedOrigin = new Map<string, number>();
  for (const e of failed) {
    const origins = new Set((byTrace.get(e.traceId) ?? []).filter((r) => r.origin).map((r) => r.service));
    for (const s of origins) failedOrigin.set(s, (failedOrigin.get(s) ?? 0) + 1 / failed.length);
  }

  // ---- per-service features
  const names = [...new Set([...SERVICES.map((s) => s.name), ...DATABASES, ...reqs.map((r) => r.service)])];
  const reports: ServiceReport[] = names.map((name) => {
    const c = cur.filter((r) => r.service === name);
    const b = base.filter((r) => r.service === name);
    const empty = c.length < MIN_REQS || b.length < MIN_REQS;

    const bucketsOf = (rs: Req[]) => {
      const m = new Map<number, Req[]>();
      for (const r of rs) m.set(bucketOf(r.start), [...(m.get(bucketOf(r.start)) ?? []), r]);
      return m;
    };
    const baseBuckets = [...bucketsOf(b).values()];
    const baseSelfMeans = baseBuckets.map((rs) => mean(rs.map((r) => r.self)));
    const baseOriginRates = baseBuckets.map((rs) => rs.filter((r) => r.origin).length / rs.length);

    const curSelf = mean(c.map((r) => r.self));
    const { z, med: baseSelf } = robustZ(curSelf, baseSelfMeans, 0.5);
    const selfAnomalous = !empty && z >= 3 && curSelf >= baseSelf * 1.3 && curSelf - baseSelf >= 5;
    const selfScore = selfAnomalous ? clamp01((z - 3) / 9) : 0;

    const originCount = c.filter((r) => r.origin).length;
    const originRate = c.length ? originCount / c.length : 0;
    const baseOrigin = median(baseOriginRates);
    const errScore = !empty && originCount >= 2 ? clamp01((originRate - baseOrigin) / 0.25) : 0;

    const contribution = clamp01(
      Math.max(((slowShare.get(name) ?? 0) - (baseShare.get(name) ?? 0)) / 0.35, failedOrigin.get(name) ?? 0),
    );

    // When did THIS service first look wrong? (1s resolution) Used for temporal precedence.
    let firstAnomalyAt: number | null = null;
    if (selfScore > 0 || errScore > 0) {
      const cb = [...bucketsOf(c).entries()].sort((x, y) => x[0] - y[0]);
      for (const [k, rs] of cb) {
        const sm = mean(rs.map((r) => r.self));
        const bz = robustZ(sm, baseSelfMeans, 0.5);
        const badSelf = bz.z >= 3 && sm >= baseSelf * 1.3 && sm - baseSelf >= 5;
        const badErr = rs.some((r) => r.origin) && baseOrigin < 0.05;
        if (badSelf || badErr) {
          firstAnomalyAt = k * BUCKET_MS;
          break;
        }
      }
    }

    const evidence: string[] = [];
    if (selfScore > 0) evidence.push(`Self time rose ${round(baseSelf, 1)}ms → ${round(curSelf, 1)}ms (robust z = ${round(z, 1)}). The extra time is spent inside this service, not waiting on dependencies.`);
    if (errScore > 0) evidence.push(`${round(originRate * 100, 0)}% of its requests fail with an error that did NOT come from a downstream call (baseline ${round(baseOrigin * 100, 0)}%).`);
    const share = (slowShare.get(name) ?? 0) - (baseShare.get(name) ?? 0);
    if (slow.length && share > 0.05) evidence.push(`In ${slow.length} slow entry-point traces it holds +${round(share * 100, 0)} points more of the critical path than normal.`);
    if (failedOrigin.get(name)) evidence.push(`It is the origin of the error in ${round((failedOrigin.get(name) ?? 0) * 100, 0)}% of the ${failed.length} failed entry-point traces.`);

    return {
      name,
      requests: c.length,
      baselineRequests: b.length,
      selfMs: { baseline: round(baseSelf, 1), current: round(curSelf, 1), z: round(z, 1) },
      totalMs: { baseline: round(mean(b.map((r) => r.dur)), 1), current: round(mean(c.map((r) => r.dur)), 1) },
      durP95: { baseline: round(percentile(b.map((r) => r.dur), 95), 1), current: round(percentile(c.map((r) => r.dur), 95), 1) },
      errorRate: { baseline: round(b.length ? b.filter((r) => r.error).length / b.length : 0, 3), current: round(c.length ? c.filter((r) => r.error).length / c.length : 0, 3) },
      originErrorRate: { baseline: round(baseOrigin, 3), current: round(originRate, 3) },
      scores: { selfTime: selfScore, errors: errScore, criticalPath: contribution, precedence: 0, leaf: 0 },
      firstAnomalyAt,
      anomalous: selfScore > 0 || errScore > 0,
      score: 0,
      role: empty ? "no data" : "healthy",
      evidence,
    };
  });

  // ---- combine signals into the final score (only for services that are themselves anomalous)
  const anomalous = reports.filter((r) => r.anomalous);
  const tMin = Math.min(...anomalous.map((r) => r.firstAnomalyAt ?? Infinity));
  for (const r of anomalous) {
    r.scores.precedence = r.firstAnomalyAt === null ? 0 : clamp01(1 - (r.firstAnomalyAt - tMin) / (opts.windowMs * 0.6));
    const deps = downstream.get(r.name) ?? [];
    const dependencyAlsoBad = deps.some((d) => {
      const dr = reports.find((x) => x.name === d);
      return dr && Math.max(dr.scores.selfTime, dr.scores.errors) > 0.3;
    });
    r.scores.leaf = dependencyAlsoBad ? 0.3 : 1; // blame flows to the deepest anomalous service
    const s = r.scores;
    r.score = round(
      WEIGHTS.selfTime * s.selfTime + WEIGHTS.errors * s.errors + WEIGHTS.criticalPath * s.criticalPath + WEIGHTS.precedence * s.precedence + WEIGHTS.leaf * s.leaf,
      3,
    );
    r.role = "root-cause suspect";
    if (r.scores.precedence === 1 && anomalous.length > 1) r.evidence.push("It was the first service to turn anomalous.");
    if (dependencyAlsoBad) r.evidence.push("A downstream dependency is also anomalous, so part of this may be inherited; score is discounted.");
    else r.evidence.push("No downstream dependency is anomalous, so the problem is not inherited from deeper in the graph.");
  }
  for (const r of reports) {
    if (r.anomalous || r.role === "no data") continue;
    const slower = r.durP95.baseline > 0 && r.durP95.current > r.durP95.baseline * 1.3 && r.durP95.current - r.durP95.baseline > 10;
    const moreErrors = r.errorRate.current - r.errorRate.baseline > 0.05;
    if (slower || moreErrors) {
      r.role = "affected (inherited)";
      r.evidence.push("Latency/errors are up here, but its own self time is normal: the problem comes from a service it calls.");
    }
  }

  const suspects = reports.filter((r) => r.anomalous).sort((a, b) => b.score - a.score);
  const total = sum(suspects.map((s) => s.score)) || 1;

  // ---- naive baselines the evaluation compares against
  const live = reports.filter((r) => r.role !== "no data");
  const naiveP99 = [...live].sort((a, b) => b.durP95.current - a.durP95.current).map((r) => r.name);
  const naiveRatio = [...live]
    .sort((a, b) => b.durP95.current / Math.max(1, b.durP95.baseline) - a.durP95.current / Math.max(1, a.durP95.baseline))
    .map((r) => r.name);

  // ---- log correlation: most frequent error messages from suspect services in the window
  const logs = suspects.slice(0, 3).map((s) => {
    const groups = new Map<string, { count: number; traceId?: string }>();
    for (const l of store.logs) {
      if (l.service !== s.name || l.level !== "error" || l.ts < curFrom) continue;
      const g = groups.get(l.msg) ?? { count: 0, traceId: l.trace_id };
      g.count++;
      groups.set(l.msg, g);
    }
    return { service: s.name, top: [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([msg, g]) => ({ msg, count: g.count, traceId: g.traceId })) };
  });

  return {
    asOf: now,
    window: { currentFrom: curFrom, baselineFrom: baseFrom, windowMs: opts.windowMs, baselineMs: opts.baselineMs },
    entry: {
      service: ENTRY_SERVICE,
      requests: entryCur.length,
      p95Ms: { baseline: round(entryBaseP95, 1), current: round(percentile(entryCur.map((r) => r.dur), 95), 1) },
      errorRate: round(entryCur.length ? failed.length / entryCur.length : 0, 3),
      slowTraces: slow.length,
      failedTraces: failed.length,
    },
    incident: suspects.length > 0 && suspects[0].score >= 0.3,
    suspects: suspects.map((s) => ({ name: s.name, score: s.score, confidence: round(s.score / total, 2) })),
    services: reports,
    graph: { nodes: names, edges: graphEdges },
    logs,
    naive: { highestP95: naiveP99, highestLatencyRatio: naiveRatio },
    weights: WEIGHTS,
    sampling: { rate: store.sampleRate, estimatedEntryRequests: Math.round(entryCur.length / Math.max(store.sampleRate, 1e-6)) },
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Views for the dashboard
// ---------------------------------------------------------------------------------------------
export function timeline(store: Store, seconds: number, now = Date.now()) {
  const from = now - seconds * 1000;
  const { reqs } = collect(store, from, now);
  const names = [...new Set([...SERVICES.map((s) => s.name), ...DATABASES, ...reqs.map((r) => r.service)])];
  const out: Record<string, Array<{ t: number; n: number; selfMs: number; p95Ms: number; errors: number; origin: number }>> = {};
  for (const name of names) {
    const rows = [];
    for (let b = bucketOf(from); b <= bucketOf(now); b++) {
      const rs = reqs.filter((r) => r.service === name && bucketOf(r.start) === b);
      rows.push({
        t: b * BUCKET_MS,
        n: rs.length,
        selfMs: round(mean(rs.map((r) => r.self)), 1),
        p95Ms: round(percentile(rs.map((r) => r.dur), 95), 1),
        errors: rs.filter((r) => r.error).length,
        origin: rs.filter((r) => r.origin).length,
      });
    }
    out[name] = rows;
  }
  return out;
}

/** Every trace we can show a person: the statistical sample PLUS the failed/slow exemplars rescued from sampling. */
function* allTraces(store: Store): Generator<[string, Span[]]> {
  yield* store.traces;
  for (const [id, spans] of store.exemplars) if (!store.traces.has(id)) yield [id, spans];
}
const findTrace = (store: Store, id: string) => store.traces.get(id) ?? store.exemplars.get(id);

/** One request, end to end: every span from every service, laid out for a waterfall. */
export function traceView(store: Store, traceId: string) {
  const spans = findTrace(store, traceId);
  if (!spans?.length) return null;
  const d = derive(traceId, spans);
  const entry = d.reqs.find((r) => r.service === ENTRY_SERVICE);
  const t0 = Math.min(...spans.map((s) => s.start));
  const selfBySpan = new Map(d.reqs.map((r) => [r.spanId, r.self]));
  // A client span doesn't know who it called; the SERVER span whose parent it is does.
  const calleeOf = new Map<string, string>();
  for (const sp of spans) if (sp.kind === "server" && sp.parentId) calleeOf.set(sp.parentId, sp.service);
  return {
    traceId,
    startedAt: t0,
    durMs: round(entry?.dur ?? Math.max(...spans.map((s) => s.end)) - t0, 1),
    error: !!entry?.error,
    failedAt: d.reqs.find((r) => r.origin)?.service ?? null,
    spans: [...spans]
      .sort((a, b) => a.start - b.start)
      .map((s) => ({
        service: s.service,
        name: s.kind === "server" ? `${s.service} (server)` : dbQueryTarget(s) ? `→ ${dbQueryTarget(s)} query` : s.kind === "client" ? `${s.service} → ${calleeOf.get(s.spanId) ?? "call"}` : s.name,
        kind: s.kind,
        offsetMs: round(s.start - t0, 1),
        durMs: round(s.dur, 1),
        selfMs: selfBySpan.has(s.spanId) ? round(selfBySpan.get(s.spanId)!, 1) : undefined,
        error: s.error,
      })),
  };
}

export function exampleTraces(store: Store, kind: "slow" | "error", seconds: number, limit: number, now = Date.now()) {
  const list = requestList(store, kind, seconds, limit, now);
  return list.map((r) => traceView(store, r.traceId)!).filter(Boolean);
}

/** Recent checkout requests, newest first, each with a best guess at WHERE it went wrong. */
export function requestList(store: Store, kind: "error" | "slow" | "all" | "problem", seconds: number, limit: number, now = Date.now()) {
  const from = now - seconds * 1000;
  const rows: Array<{ traceId: string; at: number; durMs: number; status: "failed" | "slow" | "ok"; blame: string | null }> = [];
  const entries: number[] = [];
  const staged: Array<{ id: string; entry: Req; origin?: string; topSelf?: string }> = [];
  for (const [id, spans] of allTraces(store)) {
    const d = derive(id, spans);
    const entry = d.reqs.find((r) => r.service === ENTRY_SERVICE);
    if (!entry || entry.start < from || entry.start > now) continue;
    entries.push(entry.dur);
    const top = [...d.reqs].sort((a, b) => b.self - a.self)[0];
    staged.push({ id, entry, origin: d.reqs.find((r) => r.origin)?.service, topSelf: top?.service });
  }
  const med = median(entries);
  const slowAt = Math.max(med * 1.6, med + 15);
  for (const { id, entry, origin, topSelf } of staged) {
    const status = entry.error ? "failed" : entry.dur >= slowAt ? "slow" : "ok";
    if (kind === "error" && status !== "failed") continue;
    if (kind === "slow" && status !== "slow") continue;
    if (kind === "problem" && status === "ok") continue;
    rows.push({ traceId: id, at: entry.start, durMs: round(entry.dur, 1), status, blame: status === "failed" ? origin ?? null : status === "slow" ? topSelf ?? null : null });
  }
  return rows.sort((a, b) => (kind === "slow" ? b.durMs - a.durMs : b.at - a.at)).slice(0, limit);
}
