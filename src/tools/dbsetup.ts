// Creates the schema and seed data in the real Postgres and Redis (idempotent). `npm run db:setup`
import { Pool } from "pg";
import Redis from "ioredis";
import { DATABASE_URL, REDIS_URL } from "../shared/config";

export async function setupDatabases(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY, name text NOT NULL);
    INSERT INTO users SELECT g, 'user-' || g FROM generate_series(1, 1000) g ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS payments (id bigserial PRIMARY KEY, order_ref text NOT NULL, amount int NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

    -- Fault-injection hook: queries pass through db_gate(), which sleeps for chaos.delay_ms.
    -- With delay_ms = 0 it costs microseconds. Setting it > 0 makes Postgres itself genuinely slow.
    CREATE TABLE IF NOT EXISTS chaos (id int PRIMARY KEY, delay_ms int NOT NULL DEFAULT 0);
    INSERT INTO chaos VALUES (1, 0) ON CONFLICT DO NOTHING;
    UPDATE chaos SET delay_ms = 0 WHERE id = 1; -- a fault left over from a previous run must not survive a restart
    CREATE OR REPLACE FUNCTION db_gate() RETURNS boolean AS $$
    DECLARE d int;
    BEGIN
      SELECT delay_ms INTO d FROM chaos WHERE id = 1;
      IF d > 0 THEN PERFORM pg_sleep(d / 1000.0); END IF;
      RETURN true;
    END $$ LANGUAGE plpgsql VOLATILE;
  `);
  await pool.end();

  const redis = new Redis(REDIS_URL);
  const pipe = redis.pipeline();
  for (let i = 1; i <= 500; i++) pipe.set(`stock:${i}`, 1000);
  await pipe.exec();
  redis.disconnect();
}

if (require.main === module) {
  setupDatabases().then(() => console.log("databases ready")).catch((e) => { console.error("db setup failed:", e.message, "\nIs `npm run db:up` running?"); process.exit(1); });
}
