import { trace } from "@opentelemetry/api";
import http from "node:http";
import { RCA_PORT } from "./config";

export type Level = "info" | "warn" | "error";

export interface LogLine {
  ts: number; // epoch ms
  level: Level;
  service: string;
  msg: string;
  trace_id?: string;
  span_id?: string;
  [k: string]: unknown;
}

const service = process.env.SERVICE_NAME ?? "unknown";
let buffer: LogLine[] = [];

/** Structured JSON logs. Every line carries the active trace_id/span_id so logs can be joined to traces. */
export function log(level: Level, msg: string, extra: Record<string, unknown> = {}) {
  const ctx = trace.getActiveSpan()?.spanContext();
  const line: LogLine = { ts: Date.now(), level, service, msg, ...extra };
  if (ctx) {
    line.trace_id = ctx.traceId;
    line.span_id = ctx.spanId;
  }
  // Info-level access logs are shipped but not echoed to the terminal (100+ lines/s would drown it). LOG_STDOUT=1 shows all.
  if (level !== "info" || process.env.LOG_STDOUT === "1") process.stdout.write(JSON.stringify(line) + "\n");
  buffer.push(line);
}

// Ship logs to the RCA engine in small batches (stand-in for a Loki/Fluent Bit pipeline).
setInterval(() => {
  if (buffer.length === 0) return;
  const body = JSON.stringify(buffer);
  buffer = [];
  const req = http.request(
    { host: "127.0.0.1", port: RCA_PORT, method: "POST", path: "/ingest/logs", headers: { "content-type": "application/json" } },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.end(body);
}, 1000).unref();
