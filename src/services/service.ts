// One generic, instrumented microservice. The launcher starts one process per entry in SERVICES,
// selected with the SERVICE_NAME env var. What differs between them is only the topology config.
import "../shared/telemetry"; // MUST stay first (registers instrumentation before node:http is used)
import http from "node:http";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { byName, ENTRY_ROUTE, ENTRY_SERVICE } from "../shared/config";
import { log } from "../shared/logger";
import { redis, pool } from "../shared/db";
import { shutdownTelemetry } from "../shared/telemetry";

const def = byName(process.env.SERVICE_NAME ?? "");
const tracer = trace.getTracer(def.name);

// ---- chaos state: the knobs the fault injector turns --------------------------------------
interface Chaos {
  latencyMs: number; // extra waiting (e.g. slow dependency)       -> adds self time
  errorRate: number; // probability [0..1] of failing with HTTP 500 -> origin errors
  cpuBurnMs: number; // busy-loop, blocks the event loop            -> adds self time for ALL requests
}
let chaos: Chaos = { latencyMs: 0, errorRate: 0, cpuBurnMs: 0 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (ms: number, spread = 0.3) => ms * (1 - spread + Math.random() * spread * 2);

/** Run `fn` inside an INTERNAL span so time spent here is visible in the trace and counts as self time. */
function inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

function callDownstream(name: string): Promise<{ status: number }> {
  const target = byName(name);
  return new Promise((resolve, reject) => {
    // Plain http.request: the HTTP instrumentation creates a CLIENT span and injects the W3C
    // `traceparent` header, which is how the trace crosses the service boundary.
    const req = http.request({ host: "127.0.0.1", port: target.port, path: "/work", method: "GET", timeout: 5000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout calling ${name}`)));
    req.on("error", reject);
    req.end();
  });
}

async function handleWork(res: http.ServerResponse) {
  if (chaos.cpuBurnMs > 0) {
    await inSpan("chaos.cpu_burn", async () => {
      const end = Date.now() + chaos.cpuBurnMs;
      while (Date.now() < end); // intentionally blocks the event loop
    });
  }
  if (chaos.latencyMs > 0) await inSpan("chaos.latency", () => sleep(jitter(chaos.latencyMs)));

  await inSpan("compute", () => sleep(jitter(def.baseWorkMs, 0.5)));

  // Real database work. The DB client spans are created by the pg / ioredis instrumentation.
  try {
    if (def.name === "payments") await pool.query("INSERT INTO payments(order_ref, amount) SELECT $1, $2 WHERE db_gate() RETURNING id", [`ord-${Math.random().toString(36).slice(2, 10)}`, Math.floor(Math.random() * 10000)]);
    else if (def.name === "users") await pool.query("SELECT name FROM users WHERE id = $1 AND db_gate()", [1 + Math.floor(Math.random() * 1000)]);
    else if (def.name === "inventory") {
      const sku = `stock:${1 + Math.floor(Math.random() * 500)}`;
      await redis.get(sku);
      await redis.incr(`reserved:${sku}`);
    }
  } catch (e) {
    log("error", `database failure: ${(e as Error).message}`, { db: def.db });
    res.writeHead(500).end(JSON.stringify({ error: `${def.name}: database failure` }));
    return;
  }

  // Fail AFTER doing the work, as a real service would. The error originates in THIS service.
  if (chaos.errorRate > 0 && Math.random() < chaos.errorRate) {
    log("error", "injected failure", { fault: "error_rate" });
    res.writeHead(500).end(JSON.stringify({ error: `${def.name}: injected failure` }));
    return;
  }

  const failed: string[] = [];
  const call = async (name: string) => {
    try {
      const r = await callDownstream(name);
      if (r.status >= 500) failed.push(`${name} returned ${r.status}`);
    } catch (e) {
      failed.push(`${name} unreachable: ${(e as Error).message}`);
    }
  };
  if (def.parallel) await Promise.all(def.calls.map(call));
  else for (const n of def.calls) await call(n);

  if (failed.length) {
    // The error PROPAGATES from a dependency; it did not originate here.
    log("error", `downstream failure: ${failed.join("; ")}`, { propagated: true });
    res.writeHead(502).end(JSON.stringify({ error: failed }));
    return;
  }
  res.writeHead(200).end(JSON.stringify({ ok: true, service: def.name }));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let b = "";
  for await (const c of req) b += c;
  return b;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  res.setHeader("content-type", "application/json");
  if (url !== "/health" && url !== "/chaos") {
    // One access-log line per request, tied to the trace it belongs to (the span context is gone by the time 'finish' fires).
    const sc = trace.getActiveSpan()?.spanContext();
    const t0 = performance.now();
    res.on("finish", () =>
      log(res.statusCode >= 500 ? "error" : "info", `${req.method} ${url} ${res.statusCode}`, { status: res.statusCode, durationMs: Math.round((performance.now() - t0) * 10) / 10, ...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}) }),
    );
  }
  try {
    if (url === "/health") return void res.end('{"ok":true}');
    if (url === "/chaos") {
      if (req.method === "POST") {
        const patch = JSON.parse((await readBody(req)) || "{}");
        chaos = { ...chaos, ...patch };
        log("warn", "chaos updated", { chaos });
      } else if (req.method === "DELETE") {
        chaos = { latencyMs: 0, errorRate: 0, cpuBurnMs: 0 };
        log("info", "chaos cleared");
      }
      return void res.end(JSON.stringify(chaos));
    }
    if (url === "/work" || (def.name === ENTRY_SERVICE && url === ENTRY_ROUTE)) return await handleWork(res);
    res.writeHead(404).end('{"error":"not found"}');
  } catch (e) {
    log("error", `unhandled: ${(e as Error).message}`);
    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
    if (!res.headersSent) res.writeHead(500).end('{"error":"internal"}');
  }
});

server.listen(def.port, "127.0.0.1", () => log("info", `${def.name} listening on :${def.port}`, { downstream: def.calls }));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdownTelemetry().finally(() => process.exit(0)));
}
