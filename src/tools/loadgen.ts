// Constant-rate load generator against the entry service. `npm run load -- [rps] [seconds]`
import http from "node:http";
import { byName, ENTRY_ROUTE, ENTRY_SERVICE } from "../shared/config";

export function startLoad(rps: number): { stop: () => void; sent: () => number } {
  const target = byName(ENTRY_SERVICE);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  let sent = 0;
  const t = setInterval(() => {
    sent++;
    const r = http.get({ host: "127.0.0.1", port: target.port, path: ENTRY_ROUTE, agent }, (res) => res.resume());
    r.on("error", () => {});
  }, 1000 / rps);
  return { stop: () => { clearInterval(t); agent.destroy(); }, sent: () => sent };
}

if (require.main === module) {
  const rps = Number(process.argv[2] ?? 20);
  const seconds = Number(process.argv[3] ?? 0);
  const l = startLoad(rps);
  console.log(`load: ${rps} req/s -> ${ENTRY_SERVICE}${ENTRY_ROUTE}${seconds ? ` for ${seconds}s` : " (Ctrl+C to stop)"}`);
  if (seconds) setTimeout(() => { l.stop(); console.log(`sent ${l.sent()} requests`); }, seconds * 1000);
}
