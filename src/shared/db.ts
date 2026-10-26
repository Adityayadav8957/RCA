// Real database clients. Import AFTER telemetry so the pg / ioredis instrumentation can patch them.
import { Pool } from "pg";
import Redis from "ioredis";
import { DATABASE_URL, REDIS_URL } from "./config";

export const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
pool.on("error", () => {}); // idle-client errors must not crash the service

export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
redis.on("error", () => {});
