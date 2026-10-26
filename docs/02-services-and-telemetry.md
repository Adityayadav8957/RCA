# 02 · Services & telemetry

← [Back to README](../README.md) · Next: [03 · RCA engine](03-rca-engine.md)

Code: [src/services/service.ts](../src/services/service.ts) · [src/shared/telemetry.ts](../src/shared/telemetry.ts) · [src/shared/logger.ts](../src/shared/logger.ts) · [src/shared/config.ts](../src/shared/config.ts)

## The services

All five are the same program. `SERVICE_NAME=payments npm run service` picks the `payments` entry from
the topology table:

| Service | Calls | Own work per request |
|---|---|---|
| gateway | users **and** orders, *in parallel* | ~3 ms compute |
| orders | payments, then inventory, *in sequence* | ~6 ms compute |
| payments | nothing | ~6 ms compute + a real **Postgres** `INSERT` |
| inventory | nothing | ~4 ms compute + real **Redis** `GET` and `INCR` |
| users | nothing | ~4 ms compute + a real **Postgres** `SELECT` |

Parallel versus sequential calls is deliberate. The RCA engine has to handle both when it decides how much
time a service "spent waiting" (see [self time](03-rca-engine.md#step-1-self-time)).

Every service also exposes:

| Endpoint | Purpose |
|---|---|
| `GET /work` | The normal request path (gateway also answers `GET /checkout`) |
| `GET /health` | Liveness, not traced |
| `GET/POST/DELETE /chaos` | Read, set or clear injected faults, not traced |

## The three signals

### 1. Traces

* `HttpInstrumentation` from OpenTelemetry wraps `node:http`. For every **incoming** request it creates a
  **SERVER** span; for every **outgoing** `http.request` it creates a **CLIENT** span and adds the
  `traceparent` header.
* The service adds its own **INTERNAL** spans: `compute` and, only while a fault is active, `chaos.latency`
  and `chaos.cpu_burn`.
* Real database calls are traced by the `pg` and `ioredis` instrumentations as **CLIENT** spans carrying
  `db.system = postgresql | redis`. The engine treats each database as a node in the dependency graph
  (see [03 · databases are nodes too](03-rca-engine.md#databases-are-nodes-too)).
* A `BatchSpanProcessor` ships finished spans to the RCA engine every 500 ms over OTLP/HTTP.

A single request therefore looks like this (times are illustrative):

```
gateway  SERVER   ████████████████████████████████████  38 ms
  gateway  CLIENT → users          ████████ 12 ms
    users  SERVER                  ███████  11 ms
  gateway  CLIENT → orders         ████████████████████████████ 33 ms
    orders SERVER                  ███████████████████████████ 32 ms
      orders CLIENT → payments       ██████████████ 20 ms
        payments SERVER                ████████████ 19 ms
          payments compute ...
        payments CLIENT → postgres (INSERT)                 ████████ 6 ms
      orders CLIENT → inventory                    ██████ 8 ms
        inventory SERVER                            █████ 7 ms
```

### 2. Metrics

The same instrumentation records a request-duration histogram. A `PeriodicExportingMetricReader` exports
it every 2 s with **delta temporality**, so each export means "what happened since the last export".
The engine stores the points and serves them at `GET /api/metrics`.

> Honest note: in this version metrics are collected and queryable, but the ranking algorithm is driven by
> traces (which carry strictly more information). Using metrics as a second, cheaper anomaly signal is a
> natural extension.

### 3. Structured logs

`log()` in [src/shared/logger.ts](../src/shared/logger.ts) prints one JSON object per line and attaches
the **active trace id and span id**:

```json
{"ts":1761402000000,"level":"error","service":"payments","msg":"injected failure","fault":"error_rate","trace_id":"4bf9...","span_id":"00f0..."}
```

Every request also produces one **access-log line** (`GET /work 200`, with status and duration; 5xx lines are logged at `error`).
Because the trace id is on every line, the engine can answer "show me the error logs that belong to this slow
request" with a simple join. Lines are also shipped to `POST /ingest/logs` in 1-second batches (a stand-in for
Loki or Fluent Bit).

## Fault injection (the "chaos" knobs)

Each service holds a small in-memory state `{latencyMs, errorRate, cpuBurnMs}`:

| Knob | What the service does | What it simulates |
|---|---|---|
| `latencyMs` | `await sleep(latency)` inside a `chaos.latency` span | A slow dependency or network (adds **self time**) |
| `errorRate` | Fails the request with HTTP 500 with that probability, after doing its normal work | A bug or bad deploy (creates **origin errors**) |
| `cpuBurnMs` | Busy-loops, blocking the Node event loop | CPU saturation or a hot loop (adds self time for *every* concurrent request) |

When a service fails because a downstream call returned 5xx, it logs `downstream failure …` and returns 502.
That error **propagated**; it did not originate there. Telling those two apart is the heart of the error signal
in the RCA engine.

### Faults inside the real databases

| Target | How the fault is applied | What really happens |
|---|---|---|
| `postgres` | `UPDATE chaos SET delay_ms = N`. Every service query passes through a SQL function `db_gate()` that sleeps `delay_ms` | The query genuinely takes N ms longer **inside Postgres**, so every service that queries it slows down |
| `redis` | A loop issues `DEBUG SLEEP` against the server | Redis's single thread really stalls, like a long-running command or a pause |

These are applied by the RCA engine process (`POST /api/chaos/postgres`), which holds the admin connections.

How to drive the knobs: [04 · Chaos & evaluation](04-chaos-and-evaluation.md).

## The real databases

`docker-compose.yml` starts **Postgres 16** and **Redis 7**. Host ports are `55432` and `56379` so they don't
collide with databases you already run. `npm run db:setup` (run automatically by `npm start`) creates the schema
and seed data in [src/tools/dbsetup.ts](../src/tools/dbsetup.ts) (idempotent):

| Store | Data | Used by |
|---|---|---|
| Postgres `users` | 1,000 rows | users: `SELECT name FROM users WHERE id = $1` |
| Postgres `payments` | one row inserted per checkout | payments: `INSERT INTO payments ...` |
| Postgres `chaos` + `db_gate()` | the fault-injection hook | both Postgres queries |
| Redis `stock:1..500` | stock counters | inventory: `GET stock:N` then `INCR reserved:stock:N` |

To point the services at your own databases, set `DATABASE_URL` and `REDIS_URL`. The fault hook then needs
the `chaos` table and `db_gate()` function, which `db:setup` creates.

