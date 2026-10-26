// RCA engine process: OTLP receiver + analysis API + dashboard, all on one port (4318).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { byName, RCA_PORT } from "../shared/config";
import { createApi, type ApiBackend } from "./api";
import { parseLogs, parseMetrics, parseTraces } from "./otlp";
import { Store } from "./store";
import { dbChaosState, setDbLatency } from "./dbchaos";
import { startLoad } from "../tools/loadgen";

const store = new Store();
// Safety switches for when the engine is reachable by other people (e.g. through a tunnel):
//   READ_ONLY=1      the dashboard can look but not touch: no faults, traffic, sampling or reset
//   INGEST_TOKEN=xyz telemetry pushes (/v1/*, /ingest/*) must send "Authorization: Bearer xyz"
const READ_ONLY = process.env.READ_ONLY === "1";
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const DASHBOARD = path.resolve(__dirname, "../../dashboard");
setInterval(() => store.prune(), 15_000).unref();
setInterval(() => store.sweepPending(), 1000).unref();

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};
const MAX_BODY = 8 * 1024 * 1024; // reject oversized pushes instead of buffering unbounded memory
const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Forward a chaos command to a service's /chaos endpoint. */
function proxyChaos(service: string, method: string, body: string): Promise<unknown> {
  const def = byName(service);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: def.port, path: "/chaos", method, headers: { "content-type": "application/json" } },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve(JSON.parse(b || "{}")));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Apply a fault to a service (HTTP to its /chaos) or to a real database (admin connection). */
async function proxyOrDb(name: string, method: string, body: string): Promise<unknown> {
  if (name === "postgres" || name === "redis") {
    // Databases only support latency faults (a real DB slowdown); errors/CPU are service-level faults.
    if (method === "POST") {
      const b = JSON.parse(body || "{}");
      if (b.latencyMs === undefined) throw new Error(`${name} only supports latency faults`);
      await setDbLatency(name, Number(b.latencyMs));
    } else if (method === "DELETE") await setDbLatency(name, 0);
    return dbChaosState();
  }
  return proxyChaos(name, method, body);
}

/** The Node engine's backend: faults go to the real services over HTTP and to the real databases; load comes from a real generator. */
const backend: ApiBackend = {
  applyFault: proxyOrDb,
  startLoad,
  databases: dbChaosState,
};
const api = createApi(store, backend);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (READ_ONLY && req.method !== "GET" && p.startsWith("/api/")) return json(res, 403, { error: "this engine is read-only" });
    if (INGEST_TOKEN && req.method === "POST" && (p.startsWith("/v1/") || p.startsWith("/ingest/")) && req.headers.authorization !== `Bearer ${INGEST_TOKEN}`) return json(res, 401, { error: "ingest token required" });
    // ---- ingest (OTLP/HTTP JSON + our tiny log shipper)
    if (req.method === "POST" && p === "/v1/traces") {
      store.addSpans(parseTraces(JSON.parse(await readBody(req))));
      return json(res, 200, {});
    }
    if (req.method === "POST" && p === "/v1/metrics") {
      store.addMetrics(parseMetrics(JSON.parse(await readBody(req))));
      return json(res, 200, {});
    }
    if (req.method === "POST" && p === "/v1/logs") {
      store.addLogs(parseLogs(JSON.parse(await readBody(req))));
      return json(res, 200, {});
    }
    if (req.method === "POST" && p === "/ingest/logs") {
      store.addLogs(JSON.parse(await readBody(req)));
      return json(res, 200, {});
    }

    // ---- dashboard API (shared with the in-browser simulation)
    const out = await api.handle(url, req.method ?? "GET", () => readBody(req));
    if (out) return json(res, out.status, out.body);

    // ---- static dashboard
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(fs.readFileSync(path.join(DASHBOARD, "index.html")));
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
  }
});

const HOST = process.env.HOST ?? "127.0.0.1"; // loopback only by default: nothing on your network can reach the engine
server.listen(RCA_PORT, HOST, () => console.log(`[rca] listening on http://${HOST}:${RCA_PORT}  (dashboard at /)${READ_ONLY ? "  [READ_ONLY]" : ""}`));
