// How much telemetry can ONE engine process take? Pushes synthetic OTLP traces and measures
// ingest throughput, analysis latency at growing store sizes, and memory. `npm run bench`
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

const PORT = 4999;
const URL_ = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => crypto.randomBytes(n).toString("hex");

const attr = (k: string, v: string) => ({ key: k, value: { stringValue: v } });
type S = { s: string; n: string; kind: number; off: number; dur: number; parent?: number; attrs?: Array<{ key: string; value: unknown }> };

// One /checkout trace: 5 services + 2 DB queries, 14 spans, shaped like real OTLP/HTTP JSON.
const SHAPE: S[] = [
  { s: "gateway", n: "GET", kind: 2, off: 0, dur: 30 },
  { s: "gateway", n: "GET", kind: 3, off: 1, dur: 10, parent: 0 },
  { s: "users", n: "GET", kind: 2, off: 2, dur: 8, parent: 1 },
  { s: "users", n: "pg.query:SELECT", kind: 3, off: 3, dur: 4, parent: 2, attrs: [attr("db.system", "postgresql")] },
  { s: "gateway", n: "GET", kind: 3, off: 1, dur: 28, parent: 0 },
  { s: "orders", n: "GET", kind: 2, off: 2, dur: 26, parent: 4 },
  { s: "orders", n: "GET", kind: 3, off: 4, dur: 14, parent: 5 },
  { s: "payments", n: "GET", kind: 2, off: 5, dur: 12, parent: 6 },
  { s: "payments", n: "pg.query:INSERT", kind: 3, off: 7, dur: 6, parent: 7, attrs: [attr("db.system", "postgresql")] },
  { s: "orders", n: "GET", kind: 3, off: 19, dur: 7, parent: 5 },
  { s: "inventory", n: "GET", kind: 2, off: 20, dur: 5, parent: 9 },
  { s: "inventory", n: "get", kind: 3, off: 21, dur: 2, parent: 10, attrs: [attr("db.system", "redis")] },
  { s: "inventory", n: "compute", kind: 1, off: 20, dur: 1, parent: 10 },
  { s: "gateway", n: "compute", kind: 1, off: 0, dur: 2, parent: 0 },
];

function traces(n: number, spreadMs: number, endAt = Date.now()) {
  const byService = new Map<string, any[]>();
  for (let i = 0; i < n; i++) {
    const traceId = hex(16);
    const ids = SHAPE.map(() => hex(8));
    const t0 = endAt - Math.random() * spreadMs;
    SHAPE.forEach((sp, j) => {
      const start = t0 + sp.off;
      const span = {
        traceId, spanId: ids[j], parentSpanId: sp.parent !== undefined ? ids[sp.parent] : "", name: sp.n, kind: sp.kind,
        startTimeUnixNano: String(Math.round(start * 1e6)), endTimeUnixNano: String(Math.round((start + sp.dur * (0.8 + Math.random() * 0.4)) * 1e6)),
        attributes: sp.attrs ?? [], status: { code: 0 },
      };
      const l = byService.get(sp.s) ?? [];
      l.push(span);
      byService.set(sp.s, l);
    });
  }
  return { resourceSpans: [...byService].map(([svc, spans]) => ({ resource: { attributes: [attr("service.name", svc)] }, scopeSpans: [{ spans }] })) };
}

const post = (body: unknown) => fetch(`${URL_}/v1/traces`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
const rssMb = (pid: number) => Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024);

(async () => {
  const engine = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["src/rca/server.ts"], { cwd: ROOT, env: { ...process.env, RCA_PORT: String(PORT) }, stdio: "ignore" });
  await sleep(3000);
  // `tsx` forks the real node process; find the listener's pid for memory readings.
  const pid = Number(execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`).toString().trim().split("\n")[0]);

  console.log("== 1. Ingest throughput (4 concurrent pushers, 100 traces = 1,400 spans per request, 10 s)");
  await fetch(`${URL_}/api/reset`, { method: "POST" });
  let sent = 0;
  const stopAt = Date.now() + 10_000;
  await Promise.all(Array.from({ length: 4 }, async () => { while (Date.now() < stopAt) { await post(traces(100, 5000)); sent += 100; } }));
  const stats = await (await fetch(`${URL_}/api/stats`)).json() as any;
  console.log(`   ${Math.round(sent / 10).toLocaleString()} traces/s  =  ${Math.round((sent * SHAPE.length) / 10).toLocaleString()} spans/s   (engine RSS ${rssMb(pid)} MB, ${stats.spans.toLocaleString()} spans stored)\n`);

  console.log("== 2. Analysis latency vs how much data sits in the 48 s analysis window");
  console.log("   traces in window | spans     | 1st /api/analysis (cold) | 2nd (cached) | engine RSS");
  for (const n of [1_000, 5_000, 20_000, 50_000]) {
    await fetch(`${URL_}/api/reset`, { method: "POST" });
    for (let i = 0; i < n; i += 500) await post(traces(Math.min(500, n - i), 46_000, Date.now() - 1000));
    const time = async () => { const t = performance.now(); await (await fetch(`${URL_}/api/analysis?window=8&baseline=40`)).text(); return Math.round(performance.now() - t); };
    const cold = await time();
    const warm = await time();
    console.log(`   ${String(n).padStart(16)} | ${String(n * SHAPE.length).padStart(9)} | ${String(cold + " ms").padStart(24)} | ${String(warm + " ms").padStart(12)} | ${rssMb(pid)} MB`);
  }
  engine.kill("SIGTERM");
  try { process.kill(pid, "SIGTERM"); } catch {}
  process.exit(0);
})();
