// A pure-software stand-in for the five services, Postgres and Redis. It produces the SAME shape of telemetry
// (spans with parent/child links, db.system attributes, access logs with trace ids) that the real services emit,
// so the real analysis code runs on it unchanged. Used by the static "simulation mode" demo.
import { byName, ENTRY_SERVICE, ENTRY_ROUTE } from "../shared/config";
import type { Span } from "../rca/otlp";
import type { LogLine } from "../shared/logger";
import type { Store } from "../rca/store";

export interface Chaos {
  latencyMs?: number;
  errorRate?: number;
  cpuBurnMs?: number;
}

const hex = (bytes: number) => Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
const jitter = (ms: number, spread = 0.3) => ms * (1 - spread + Math.random() * spread * 2);
const round1 = (x: number) => Math.round(x * 10) / 10;
const HOP = 0.4; // simulated network hop, ms

export class Simulator {
  faults = new Map<string, Chaos>();
  dbDelay: Record<string, number> = { postgres: 0, redis: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private store: Store) {}

  setFault(name: string, patch: Chaos | null) {
    if (patch === null) this.faults.delete(name);
    else this.faults.set(name, { ...this.faults.get(name), ...patch });
  }

  start(rps: number) {
    this.stop();
    let last = Date.now();
    let carry = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      carry += (rps * dt) / 1000;
      const n = Math.floor(carry);
      carry -= n;
      const spans: Span[] = [];
      const logs: LogLine[] = [];
      for (let i = 0; i < n; i++) this.trace(now - Math.random() * dt, spans, logs);
      if (n) {
        this.store.addSpans(spans);
        this.store.addLogs(logs);
      }
    }, 150);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One checkout request through the whole system, exactly as the real services would handle it. */
  private trace(t0: number, spans: Span[], logs: LogLine[]) {
    const traceId = hex(16);
    const mk = (service: string, name: string, kind: Span["kind"], start: number, dur: number, parentId?: string, attrs: Span["attrs"] = {}): Span => {
      const s: Span = { traceId, spanId: hex(8), parentId, service, name, kind, start, end: start + dur, dur, error: false, attrs };
      spans.push(s);
      return s;
    };
    const log = (service: string, level: LogLine["level"], msg: string, ts: number, span: Span, extra: Record<string, unknown> = {}) =>
      logs.push({ ts, level, service, msg, trace_id: traceId, span_id: span.spanId, ...extra });

    const serve = (name: string, start: number, parent: Span | undefined, route: string): { end: number; status: number } => {
      const def = byName(name);
      const chaos = this.faults.get(name) ?? {};
      const server = mk(name, "GET", "server", start, 0, parent?.spanId);
      let t = start;

      if (chaos.cpuBurnMs) { const d = jitter(chaos.cpuBurnMs, 0.2); mk(name, "chaos.cpu_burn", "internal", t, d, server.spanId); t += d; }
      if (chaos.latencyMs) { const d = jitter(chaos.latencyMs); mk(name, "chaos.latency", "internal", t, d, server.spanId); t += d; }
      { const d = jitter(def.baseWorkMs, 0.5); mk(name, "compute", "internal", t, d, server.spanId); t += d; }

      // Real-database work. A DB query is a CLIENT span carrying db.system, like the pg / ioredis instrumentation produces.
      if (def.db === "postgres") {
        const d = jitter(name === "payments" ? 6 : 3) + this.dbDelay.postgres;
        mk(name, name === "payments" ? "pg.query:INSERT" : "pg.query:SELECT", "client", t, d, server.spanId, { "db.system": "postgresql" });
        t += d;
      } else if (def.db === "redis") {
        for (const cmd of ["get", "incr"]) {
          const d = jitter(1.2) + this.dbDelay.redis * Math.random(); // a stalled Redis blocks each command for a random part of the stall
          mk(name, cmd, "client", t, d, server.spanId, { "db.system": "redis" });
          t += d;
        }
      }

      let status = 200;
      if (chaos.errorRate && Math.random() < chaos.errorRate) {
        status = 500;
        log(name, "error", "injected failure", t, server, { fault: "error_rate" });
      } else if (def.calls.length) {
        const failed: string[] = [];
        const ends: number[] = [];
        let cursor = t;
        for (const target of def.calls) {
          const cstart = def.parallel ? t : cursor;
          const client = mk(name, "GET", "client", cstart, 0, server.spanId);
          const r = serve(target, cstart + HOP, client, "/work");
          client.end = r.end + HOP;
          client.dur = client.end - client.start;
          if (r.status >= 500) { client.error = true; failed.push(`${target} returned ${r.status}`); }
          ends.push(client.end);
          cursor = client.end;
        }
        t = def.parallel ? Math.max(...ends) : cursor;
        if (failed.length) {
          status = 502;
          log(name, "error", `downstream failure: ${failed.join("; ")}`, t, server, { propagated: true });
        }
      }

      server.end = t + HOP;
      server.dur = server.end - server.start;
      server.error = status >= 500;
      log(name, status >= 500 ? "error" : "info", `GET ${route} ${status}`, server.end, server, { status, durationMs: round1(server.dur) });
      return { end: server.end, status };
    };

    serve(ENTRY_SERVICE, t0, undefined, ENTRY_ROUTE);
  }
}
