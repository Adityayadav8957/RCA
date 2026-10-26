import type { LogLine } from "../shared/logger";
import type { MetricPoint, Span } from "./otlp";

const RETENTION_MS = 10 * 60 * 1000;
const MAX_SPANS = Number(process.env.MAX_SPANS ?? 500_000); // hard memory ceiling
const MAX_LOGS = Number(process.env.MAX_LOGS ?? 100_000);
const LEVEL_RANK = { info: 0, warn: 1, error: 2 } as const;
// The RCA only ever reads ERROR logs, so by default we refuse to store anything below WARN.
const MIN_LOG_LEVEL = (process.env.LOG_MIN_LEVEL ?? "info") as keyof typeof LEVEL_RANK; // demo default: keep everything; use "warn" in production

// ---- trace-ID-based sampling -------------------------------------------------------------------
// Every span of a trace carries the same trace id, so hashing the id gives every service's spans the SAME keep/drop
// decision with no coordination and no waiting: a kept trace is always complete, a dropped one is dropped whole.
const EXEMPLAR_SLOW_MS = Number(process.env.EXEMPLAR_SLOW_MS ?? 250); // a trace at least this long is "interesting"
const PENDING_GRACE_MS = 2500; // wait for late spans of a dropped trace before judging it
const MAX_PENDING_SPANS = 60_000;
const MAX_EXEMPLARS = 1_000;

/** Uniform number in [0,1) derived from the trace id. W3C trace ids are random, so the low 32 bits are a fair dice. */
export const traceDice = (traceId: string): number => parseInt(traceId.slice(-8), 16) / 0x1_0000_0000;

/** In-memory telemetry store with hard caps. A real system would use ClickHouse/Tempo/Loki. */
export class Store {
  traces = new Map<string, Span[]>();
  logs: LogLine[] = [];
  metrics: MetricPoint[] = [];
  spanCount = 0;
  /** Fraction of traces kept for statistics (1 = keep all). */
  sampleRate = Math.min(1, Math.max(0, Number(process.env.TRACE_SAMPLE_RATE ?? 1)));
  /** Sampled-out spans wait here briefly; if the trace turns out to be a failure or slow, it is promoted to exemplars. */
  pending = new Map<string, { spans: Span[]; firstSeen: number }>();
  pendingSpans = 0;
  /** Failed / slow traces kept as EVIDENCE even though they were sampled out of the statistics. */
  exemplars = new Map<string, Span[]>();
  counters = { spansIn: 0, logsIn: 0, logsDroppedByLevel: 0, logsDroppedByCap: 0, tracesEvicted: 0, spansSampledOut: 0, exemplarsKept: 0 };

  setSampleRate(rate: number) {
    this.sampleRate = Math.min(1, Math.max(0, rate));
  }

  addSpans(spans: Span[]) {
    this.counters.spansIn += spans.length;
    let kept = 0;
    for (const s of spans) {
      const known = this.traces.has(s.traceId);
      if (!known && traceDice(s.traceId) >= this.sampleRate) {
        // Sampled out of the statistics. Park it briefly so failures/slow traces can still be rescued as evidence.
        if (this.exemplars.has(s.traceId)) this.exemplars.get(s.traceId)!.push(s);
        else if (this.pendingSpans < MAX_PENDING_SPANS) {
          const p = this.pending.get(s.traceId);
          if (p) p.spans.push(s);
          else this.pending.set(s.traceId, { spans: [s], firstSeen: Date.now() });
          this.pendingSpans++;
        }
        this.counters.spansSampledOut++;
        continue;
      }
      const list = this.traces.get(s.traceId);
      if (list) list.push(s);
      else this.traces.set(s.traceId, [s]);
      kept++;
    }
    this.spanCount += kept;
    // Over the ceiling: evict the OLDEST traces first (Map iterates in insertion order).
    if (this.spanCount > MAX_SPANS) {
      for (const [id, list] of this.traces) {
        if (this.spanCount <= MAX_SPANS * 0.9) break;
        this.spanCount -= list.length;
        this.traces.delete(id);
        this.counters.tracesEvicted++;
      }
    }
  }
  /** Judge parked traces whose grace period is over: keep failures and slow ones as exemplars, forget the rest. */
  sweepPending(now = Date.now()) {
    for (const [id, p] of this.pending) {
      if (now - p.firstSeen < PENDING_GRACE_MS) continue;
      this.pending.delete(id);
      this.pendingSpans -= p.spans.length;
      const start = Math.min(...p.spans.map((s) => s.start));
      const end = Math.max(...p.spans.map((s) => s.end));
      if (p.spans.some((s) => s.error) || end - start >= EXEMPLAR_SLOW_MS) {
        this.exemplars.set(id, p.spans);
        this.counters.exemplarsKept++;
        if (this.exemplars.size > MAX_EXEMPLARS) this.exemplars.delete(this.exemplars.keys().next().value!);
      }
    }
  }
  addLogs(lines: LogLine[]) {
    this.counters.logsIn += lines.length;
    const kept = lines.filter((l) => LEVEL_RANK[l.level] >= LEVEL_RANK[MIN_LOG_LEVEL]);
    this.counters.logsDroppedByLevel += lines.length - kept.length;
    this.logs.push(...kept);
    if (this.logs.length > MAX_LOGS) {
      this.counters.logsDroppedByCap += this.logs.length - MAX_LOGS;
      this.logs = this.logs.slice(-MAX_LOGS);
    }
  }
  addMetrics(points: MetricPoint[]) {
    this.metrics.push(...points);
  }
  prune(now = Date.now()) {
    const cutoff = now - RETENTION_MS;
    for (const [id, spans] of this.traces) {
      let newest = 0;
      for (const s of spans) if (s.end > newest) newest = s.end;
      if (newest < cutoff) {
        this.spanCount -= spans.length;
        this.traces.delete(id);
      }
    }
    for (const [id, spans] of this.exemplars) if (Math.max(...spans.map((s) => s.end)) < cutoff) this.exemplars.delete(id);
    this.logs = this.logs.filter((l) => l.ts >= cutoff);
    this.metrics = this.metrics.filter((m) => m.ts >= cutoff);
  }
  reset() {
    this.pending.clear();
    this.pendingSpans = 0;
    this.exemplars.clear();
    this.traces.clear();
    this.spanCount = 0;
    this.logs = [];
    this.metrics = [];
  }
}
