// Single source of truth for the demo system's topology and ports.
// The services use it to know who they call; the launcher uses it to start them.

export interface ServiceDef {
  name: string;
  port: number;
  /** Downstream services called (in order) for every request. */
  calls: string[];
  /** If true, downstream calls are issued concurrently instead of sequentially. */
  parallel?: boolean;
  /** Real database this service queries on every request (see docker-compose.yml). */
  db?: "postgres" | "redis";
  /** Baseline CPU-ish work per request, in ms (uniform 1x..2x). */
  baseWorkMs: number;
}

export const RCA_PORT = Number(process.env.RCA_PORT ?? 4318); // the standard OTLP/HTTP port, so a real Collector could replace the RCA engine
export const RCA_URL = `http://127.0.0.1:${RCA_PORT}`;

export const SERVICES: ServiceDef[] = [
  { name: "gateway", port: 3000, calls: ["users", "orders"], parallel: true, baseWorkMs: 3 },
  { name: "orders", port: 3001, calls: ["payments", "inventory"], baseWorkMs: 6 },
  { name: "payments", port: 3002, calls: [], baseWorkMs: 6, db: "postgres" },
  { name: "inventory", port: 3003, calls: [], baseWorkMs: 4, db: "redis" },
  { name: "users", port: 3004, calls: [], baseWorkMs: 4, db: "postgres" },
];

/** Databases are first-class nodes in the dependency graph: they can be blamed just like services. */
export const DATABASES = ["postgres", "redis"] as const;
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rca:rca@127.0.0.1:55432/shop";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";

export const ENTRY_SERVICE = "gateway";
export const ENTRY_ROUTE = "/checkout";

export const byName = (name: string): ServiceDef => {
  const s = SERVICES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown service ${name}`);
  return s;
};
