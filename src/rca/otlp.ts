// Minimal OTLP/HTTP JSON decoding: just the fields the RCA engine needs.

export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  service: string;
  name: string;
  kind: "internal" | "server" | "client" | "other";
  start: number; // epoch ms (fractional)
  end: number;
  dur: number; // ms
  error: boolean;
  attrs: Record<string, string | number | boolean>;
}

export interface MetricPoint {
  service: string;
  name: string;
  ts: number;
  count: number;
  sum: number;
}

const KINDS: Record<number, Span["kind"]> = { 1: "internal", 2: "server", 3: "client" };

type AnyVal = Record<string, any>;

function nanoToMs(v: unknown): number {
  if (typeof v === "string" || typeof v === "number") return Number(v) / 1e6;
  if (v && typeof v === "object") {
    const { low = 0, high = 0 } = v as { low?: number; high?: number };
    return ((high >>> 0) * 4294967296 + (low >>> 0)) / 1e6;
  }
  return 0;
}

function attrMap(list: AnyVal[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const a of list ?? []) {
    const v = a.value ?? {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? "";
    if (typeof out[a.key] === "string" && v.intValue !== undefined) out[a.key] = Number(v.intValue);
  }
  return out;
}

export function parseTraces(body: AnyVal): Span[] {
  const spans: Span[] = [];
  for (const rs of body.resourceSpans ?? []) {
    const service = String(attrMap(rs.resource?.attributes)["service.name"] ?? "unknown");
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const start = nanoToMs(s.startTimeUnixNano);
        const end = nanoToMs(s.endTimeUnixNano);
        spans.push({
          traceId: s.traceId,
          spanId: s.spanId,
          parentId: s.parentSpanId || undefined,
          service,
          name: s.name,
          kind: KINDS[s.kind] ?? "other",
          start,
          end,
          dur: end - start,
          error: s.status?.code === 2,
          attrs: attrMap(s.attributes),
        });
      }
    }
  }
  return spans;
}

export function parseMetrics(body: AnyVal): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const rm of body.resourceMetrics ?? []) {
    const service = String(attrMap(rm.resource?.attributes)["service.name"] ?? "unknown");
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        if (!/duration/.test(m.name) || !m.histogram) continue;
        for (const dp of m.histogram.dataPoints ?? []) {
          out.push({ service, name: m.name, ts: nanoToMs(dp.timeUnixNano), count: Number(dp.count ?? 0), sum: Number(dp.sum ?? 0) });
        }
      }
    }
  }
  return out;
}

/** OTLP/HTTP JSON logs (what an OpenTelemetry Collector's `otlphttp` exporter sends to /v1/logs). */
export function parseLogs(body: AnyVal): Array<{ ts: number; level: "info" | "warn" | "error"; service: string; msg: string; trace_id?: string; span_id?: string }> {
  const out = [];
  for (const rl of body.resourceLogs ?? []) {
    const service = String(attrMap(rl.resource?.attributes)["service.name"] ?? "unknown");
    for (const sl of rl.scopeLogs ?? []) {
      for (const r of sl.logRecords ?? []) {
        const n = Number(r.severityNumber ?? 9); // OTel: 1-8 trace/debug, 9-12 info, 13-16 warn, 17-24 error/fatal
        out.push({
          ts: nanoToMs(r.timeUnixNano ?? r.observedTimeUnixNano) || Date.now(),
          level: (n >= 17 ? "error" : n >= 13 ? "warn" : "info") as "info" | "warn" | "error",
          service,
          msg: String(r.body?.stringValue ?? ""),
          trace_id: r.traceId || undefined,
          span_id: r.spanId || undefined,
        });
      }
    }
  }
  return out;
}
