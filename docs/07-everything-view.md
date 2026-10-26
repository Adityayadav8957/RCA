# 07 · The "Everything" view: a full console in one frame

← [Back to README](../README.md)

Open **http://127.0.0.1:4318/#all** or press **Everything** in the top bar. The guided page teaches the idea; this view is a
**console**: you can control the system, watch it, and dig into a single request without leaving the screen.

```
┌─ Controls ──────────────────────────────────────────────────────────────────────┐
│ Traffic · Trace sampling · Inject a fault · One-click faults · Active · Undo all │
├─ KPI strip ─────────────────────────────────────────────────────────────────────┤
│ Status / culprit │ Checkout p95 │ Checkout errors │ Throughput │ Sampling        │
├─ Services ───────┬─ [Speed | Call graph | Own vs waiting] ─┬─ Live logs ─────────┤
│ culprit vs       │ chart / graph / bars                     │ every service,      │
│ waiting vs fine  │ ───────────────────────────────          │ filter, search,     │
│ click = filter   │ Requests: Problems/Failed/Slow/All       │ pause, clear        │
│ logs             │ range 1m / 5m / 10m                      │                     │
├─ Request inspector ─────────────────────────────────────────┴─────────────────────┤
│ one request: every span call by call   │  every log line that request produced    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Every option, and what it does

**Controls (top row)**

| Option | What it does |
|---|---|
| Traffic: Off / 20/s / 60/s | Starts or stops the fake customers |
| Trace sampling: 100% / 25% / 5% | Keeps that share of traces for the statistics. See [06 · Sampling](06-production-guide.md#sampling-what-is-built) |
| Inject a fault | Pick a service or database, a fault type (latency, error rate, CPU burn) and a value, then **Inject**. Databases only allow latency. |
| One-click faults | Five ready-made scenarios. Click to inject, click again to undo. Highlighted = active. |
| Active | Every fault currently injected. Click one to remove just that fault. |
| Undo all | Removes every fault and relearns "normal" |

**Panels**

| Panel | Options |
|---|---|
| Services | Click a service to filter the logs to it. Hover for the main evidence line. Shows own time now vs before, p95 and error rate. |
| Middle top | **Speed** (checkout p95 per second), **Call graph** (click a node to filter logs), **Own vs waiting** (where each request's time goes) |
| Requests | Filter **Problems** (failed + slow), **Failed**, **Slow**, **All**; range **1m / 5m / 10m**. Each row says where it went wrong. |
| Live logs | Level (All / Warn+ / Errors), service chips, free-text search, **Only this request**, **Pause / Resume**, **Clear** |
| Inspector | **Copy id** and **Raw JSON** for the request. Left: spans call by call. Right: every log line from every service for that request. |

## How to use it when something fails

1. **Inject or wait for a failure.** Status names the culprit and *Checkout errors* shows the damage.
2. **Services:** the orange dot is the culprit; dashed circles are services only waiting on it.
3. **Requests:** the first problem request opens automatically in the inspector. Click another to switch.
4. **Inspector, left:** the solid orange bar is where the failure *started*. Hollow orange bars are services that only passed the error up.
5. **Inspector, right:** every log line of that request, in time order, with the offset from the start of the request.
6. **Live logs:** lines that belong to the inspected request are highlighted in blue. Turn on **Only this request** to see just those.

## What "every log of a request" means technically

Each log line is written with the active **trace id**. The engine answers `GET /api/trace?id=…` with that request's spans *and*
every stored log line carrying the same trace id, so a single call returns everything that happened to one request across all
services. See [06 · Production guide](06-production-guide.md#3-how-is-a-log-checked-against-the-services).

## Limits to know about

* Logs are only linked to requests when the line carries a trace id. Logs without one still appear in the stream, but cannot be tied to a request.
* With **sampling** below 100%, a request's *spans* are available only if it was kept for statistics, or if it failed or was slow
  (those are always kept as evidence). Its *logs* are always stored.
* The browser keeps the latest ~1,000 log lines; the engine keeps 10 minutes (at most 100,000 lines). Older requests show "Trace not available".
* Fault, traffic and sampling settings live on the engine, so they stay in sync between the Guided and Everything views and across page refreshes.
