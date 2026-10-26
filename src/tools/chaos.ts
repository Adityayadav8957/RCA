// Fault injector CLI.
//   npm run chaos -- payments latency 200     add 200ms of waiting inside payments
//   npm run chaos -- inventory errors 0.5     make 50% of inventory requests fail with 500
//   npm run chaos -- orders cpu 80            burn 80ms of CPU per request (blocks the event loop)
//   npm run chaos -- postgres latency 200     make the REAL Postgres 200ms slower per query (also: redis)
//   npm run chaos -- payments clear           remove all faults from payments
//   npm run chaos -- all clear
import http from "node:http";
import { byName, DATABASES, RCA_URL, SERVICES } from "../shared/config";

/** Retries transient connection errors: a busy service can be slow to accept the fault-injection call. */
export async function setChaos(service: string, patch: Record<string, number> | null): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await setChaosOnce(service, patch);
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function setChaosOnce(service: string, patch: Record<string, number> | null): Promise<void> {
  if ((DATABASES as readonly string[]).includes(service)) {
    // Database faults are applied by the RCA engine process (it holds the DB admin connections).
    return fetch(`${RCA_URL}/api/chaos/${service}`, { method: patch ? "POST" : "DELETE", body: patch ? JSON.stringify(patch) : undefined })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
  }
  const def = byName(service);
  return new Promise((resolve, reject) => {
    const body = patch ? JSON.stringify(patch) : "";
    const req = http.request({ host: "127.0.0.1", port: def.port, path: "/chaos", method: patch ? "POST" : "DELETE", timeout: 4000, headers: { "content-type": "application/json" } }, (r) => {
      r.resume();
      r.on("end", () => resolve());
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

export const FAULTS = {
  latency: (v: number) => ({ latencyMs: v }),
  errors: (v: number) => ({ errorRate: v }),
  cpu: (v: number) => ({ cpuBurnMs: v }),
} as const;

if (require.main === module) {
  const [service, kind, value] = process.argv.slice(2);
  (async () => {
    if (!service || !kind) return console.log("usage: npm run chaos -- <service|all> <latency|errors|cpu|clear> [value]");
    const targets = service === "all" ? [...SERVICES.map((s) => s.name), ...DATABASES] : [service];
    for (const t of targets) {
      if (kind === "clear") await setChaos(t, null);
      else await setChaos(t, FAULTS[kind as keyof typeof FAULTS](Number(value)));
      console.log(`${t}: ${kind}${value ? " " + value : ""}`);
    }
  })();
}
