// Simulation mode for static hosting: the REAL engine (store + analysis + the dashboard's HTTP API) runs inside the
// browser, fed by a simulator instead of real services. The dashboard is unchanged: its fetch("/api/...") calls are
// answered here instead of by a server.
import { DATABASES } from "../shared/config";
import { createApi, type ApiBackend } from "../rca/api";
import { Store } from "../rca/store";
import { Simulator, type Chaos } from "./simulator";

const store = new Store();
const sim = new Simulator(store);

const backend: ApiBackend = {
  async applyFault(name, method, body) {
    if ((DATABASES as readonly string[]).includes(name)) {
      if (method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.latencyMs === undefined) throw new Error(`${name} only supports latency faults`);
        sim.dbDelay[name] = Number(b.latencyMs);
      } else if (method === "DELETE") sim.dbDelay[name] = 0;
      return { ...sim.dbDelay };
    }
    if (method === "POST") sim.setFault(name, JSON.parse(body || "{}") as Chaos);
    else if (method === "DELETE") sim.setFault(name, null);
    return sim.faults.get(name) ?? {};
  },
  startLoad: (rps) => {
    sim.start(rps);
    return { stop: () => sim.stop() };
  },
  databases: () => ({ ...sim.dbDelay }),
};

const api = createApi(store, backend);
setInterval(() => store.sweepPending(), 1000);
// Keep ~3 minutes in the browser (the Node engine keeps 10): the analysis only ever looks at the last ~50 seconds.
setInterval(() => store.prune(Date.now() - 7 * 60 * 1000), 15_000);

(window as unknown as { __SIM__: boolean }).__SIM__ = true;
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const out = await api.handle(url, (init?.method ?? "GET").toUpperCase(), async () => String(init?.body ?? ""));
  return new Response(JSON.stringify(out?.body ?? { error: "not found" }), { status: out?.status ?? 404, headers: { "content-type": "application/json" } });
};
