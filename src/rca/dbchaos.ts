// Fault injection for the REAL databases. Lives in the long-running engine process because the
// Redis fault is a loop that must keep running until cleared.
import { Pool } from "pg";
import Redis from "ioredis";
import { DATABASE_URL, REDIS_URL } from "../shared/config";

let pool: Pool | undefined;
let redis: Redis | undefined;
const state = { postgres: 0, redis: 0 };
let stalling = false;

export const dbChaosState = () => ({ ...state });

export async function setDbLatency(db: "postgres" | "redis", ms: number): Promise<void> {
  state[db] = ms;
  if (db === "postgres") {
    pool ??= new Pool({ connectionString: DATABASE_URL, max: 1 });
    // Every query goes through db_gate(), which now sleeps `ms` inside the database.
    await pool.query("UPDATE chaos SET delay_ms = $1 WHERE id = 1", [Math.round(ms)]);
    return;
  }
  redis ??= new Redis(REDIS_URL);
  if (ms > 0 && !stalling) {
    stalling = true;
    // DEBUG SLEEP blocks the Redis server's single thread, exactly like a long-running command or a stall.
    void (async () => {
      while (state.redis > 0) {
        await redis!.call("DEBUG", "SLEEP", String(state.redis / 1000)).catch(() => {});
        await new Promise((r) => setTimeout(r, 15)); // let queued client commands through between stalls
      }
      stalling = false;
    })();
  }
}
