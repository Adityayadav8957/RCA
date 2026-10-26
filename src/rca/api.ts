// The dashboard's HTTP API, written once and used twice: by the Node engine (real services) and by the
// in-browser simulation (static hosting). It only talks to a Store and a small Backend interface.
import { SERVICES } from "../shared/config";
import { analyze, exampleTraces, requestList, timeline, traceView } from "./analyze";
import type { Store } from "./store";

export interface ApiBackend {
  /** Apply (POST), clear (DELETE) or read (GET) a fault on a service or database. Throws for invalid requests. */
  applyFault(name: string, method: string, body: string): Promise<unknown>;
  startLoad(rps: number): { stop: () => void };
  databases(): Record<string, number>;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

/** Every search word must match. Long hex words are looked up in the trace/span ids; ordinary words in what you can read on the line
 *  (level, service, message, status), so "500" finds status 500 and not a trace id that happens to contain those digits. */
export function matches(l: { level: string; service: string; msg: string; trace_id?: string; span_id?: string; status?: unknown }, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = `${l.level} ${l.service} ${l.msg} ${l.status ?? ""}`.toLowerCase();
  const ids = `${l.trace_id ?? ""} ${l.span_id ?? ""}`.toLowerCase();
  return terms.every((t) => (t.length >= 8 && /^[0-9a-f]+$/.test(t) ? ids.includes(t) : text.includes(t)));
}

export function createApi(store: Store, backend: ApiBackend) {
  // Guided-demo state (kept with the engine so a page refresh doesn't lose it).
  let load: { stop: () => void; rps: number } | null = null;
  const faults = new Map<string, Record<string, number>>();
  let injectedAt: number | null = null; // when the first fault of the current scenario was injected

  async function handle(url: URL, method: string, readBody: () => Promise<string>): Promise<ApiResult | null> {
    const p = url.pathname;
    const q = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
    const ok = (body: unknown): ApiResult => ({ status: 200, body });

    if (p === "/api/analysis") {
      const now = Date.now() - q("lag", 1) * 1000;
      // Once a fault was injected from the dashboard, diagnose exactly the time since then and use the 40 s BEFORE it
      // as the baseline, so the baseline is never contaminated by the incident itself.
      const anchored = !url.searchParams.has("window") && injectedAt !== null;
      const windowMs = anchored ? Math.min(90_000, Math.max(4_000, now - injectedAt!)) : q("window", 8) * 1000;
      return ok({ ...analyze(store, { windowMs, baselineMs: q("baseline", 40) * 1000, now }), injectedAt });
    }
    if (p === "/api/state") {
      return ok({
        load: load ? { running: true, rps: load.rps } : { running: false, rps: 0 },
        faults: Object.fromEntries(faults),
        injectedAt,
        databases: backend.databases(),
        sampling: { rate: store.sampleRate, exemplars: store.exemplars.size, sampledOutSpans: store.counters.spansSampledOut, spansIn: store.counters.spansIn },
      });
    }
    if (p === "/api/load") {
      load?.stop();
      load = null;
      if (method === "POST") {
        const rps = Math.min(200, Math.max(1, Number(JSON.parse((await readBody()) || "{}").rps ?? 20)));
        load = { ...backend.startLoad(rps), rps };
      }
      return ok({ running: !!load, rps: load?.rps ?? 0 });
    }
    if (p === "/api/scenario/clear" && method === "POST") {
      for (const name of [...SERVICES.map((s) => s.name), "postgres", "redis"]) await backend.applyFault(name, "DELETE", "");
      faults.clear();
      injectedAt = null;
      store.reset(); // the old baseline contains the incident; start learning "normal" again
      return ok({ ok: true });
    }
    if (p === "/api/timeline") return ok(timeline(store, q("seconds", 90)));
    if (p === "/api/traces") return ok(exampleTraces(store, url.searchParams.get("kind") === "error" ? "error" : "slow", q("seconds", 20), q("limit", 5)));
    if (p === "/api/logs") {
      // Filters: service, traceId, min level, text search, and `since` (epoch ms) for cheap incremental polling.
      const svc = url.searchParams.get("service"), tid = url.searchParams.get("traceId"), terms = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const rank = { info: 0, warn: 1, error: 2 } as const, min = rank[(url.searchParams.get("level") as keyof typeof rank) ?? "info"] ?? 0;
      const since = q("since", Date.now() - q("seconds", 30) * 1000);
      const lines = store.logs.filter((l) => l.ts > since && (!svc || l.service === svc) && (!tid || l.trace_id === tid) && rank[l.level] >= min && matches(l, terms));
      return ok(lines.slice(-q("limit", 100)));
    }
    if (p === "/api/requests") return ok(requestList(store, (url.searchParams.get("kind") as "error" | "slow" | "all" | "problem") ?? "all", q("seconds", 60), q("limit", 40)));
    if (p === "/api/trace") {
      const id = url.searchParams.get("id") ?? "";
      const view = traceView(store, id);
      if (!view) return { status: 404, body: { error: "trace not found (sampled out, or older than retention)" } };
      // Every log line, from EVERY service, that belongs to this one request.
      return ok({ ...view, logs: store.logs.filter((l) => l.trace_id === id) });
    }
    if (p === "/api/sampling") {
      if (method === "POST") store.setSampleRate(Number(JSON.parse((await readBody()) || "{}").rate));
      return ok({ rate: store.sampleRate, counters: store.counters, pendingTraces: store.pending.size, exemplars: store.exemplars.size });
    }
    if (p === "/api/metrics") {
      const out: Record<string, Array<{ ts: number; count: number; avgMs: number }>> = {};
      for (const m of store.metrics.filter((m) => m.ts >= Date.now() - q("seconds", 90) * 1000)) {
        (out[m.service] ??= []).push({ ts: m.ts, count: m.count, avgMs: m.count ? Math.round((m.sum / m.count) * 10) / 10 : 0 });
      }
      return ok(out);
    }
    if (p === "/api/reset" && method === "POST") {
      store.reset();
      return ok({ ok: true });
    }
    if (p === "/api/stats") {
      return ok({ traces: store.traces.size, spans: store.spanCount, sampleRate: store.sampleRate, exemplars: store.exemplars.size, logs: store.logs.length, metricPoints: store.metrics.length, counters: store.counters, services: SERVICES.map((s) => s.name) });
    }
    const m = p.match(/^\/api\/chaos\/([a-z]+)$/);
    if (m) {
      const body = method === "POST" ? await readBody() : "";
      try {
        const out = await backend.applyFault(m[1], method, body);
        if (method === "POST") {
          faults.set(m[1], JSON.parse(body));
          injectedAt ??= Date.now();
        } else if (method === "DELETE") faults.delete(m[1]);
        return ok(out);
      } catch (e) {
        return { status: 400, body: { error: (e as Error).message } };
      }
    }
    return null;
  }

  return { handle };
}
