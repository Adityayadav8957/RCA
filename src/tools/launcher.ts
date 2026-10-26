// Starts the RCA engine + every service as child processes. `npm start`.
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { RCA_PORT, SERVICES } from "../shared/config";
import { setupDatabases } from "./dbsetup";

const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

function waitFor(port: number, p = "/health", tries = 80): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 500 }, (r) => {
        r.resume();
        resolve();
      });
      req.on("error", () => (n <= 0 ? reject(new Error(`port ${port} never came up`)) : setTimeout(() => attempt(n - 1), 250)));
      req.on("timeout", () => req.destroy());
    };
    attempt(tries);
  });
}

export interface Stack {
  stop: () => void;
}

export async function startStack(opts: { quiet?: boolean } = {}): Promise<Stack> {
  try {
    await setupDatabases(); // needs `npm run db:up` first
  } catch (e) {
    console.error(`\n✘ Cannot reach Postgres/Redis (${(e as Error).message}).\n  Start Docker, then run:  npm run db:up\n`);
    process.exit(1);
  }
  const procs: ChildProcess[] = [];
  const run = (file: string, env: Record<string, string>, tag: string) => {
    const p = spawn(TSX, [file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    if (!opts.quiet) {
      p.stdout?.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
      p.stderr?.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
    }
    procs.push(p);
  };
  run("src/rca/server.ts", {}, "rca");
  await waitFor(RCA_PORT, "/api/stats");
  for (const s of SERVICES) run("src/services/service.ts", { SERVICE_NAME: s.name }, s.name);
  await Promise.all(SERVICES.map((s) => waitFor(s.port)));
  return { stop: () => procs.forEach((p) => p.kill("SIGTERM")) };
}

if (require.main === module) {
  startStack({ quiet: process.env.QUIET === "1" }).then((stack) => {
    console.log(`\n✔ stack up. Dashboard: http://127.0.0.1:${RCA_PORT}\n  Generate traffic with:  npm run load\n  Inject a fault with:    npm run chaos -- payments latency 200\n`);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stack.stop(); process.exit(0); });
  });
}
