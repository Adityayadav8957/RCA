# 05 · Learning guide

← [Back to README](../README.md)

Everything you should understand to explain this project in an interview, in a sensible order. Each topic
says **where it appears in the code** so you can read a real example right away.

## Learning order

| # | Topic | One-line explanation | Where in this repo |
|---|---|---|---|
| 1 | **Microservices & failure modes** | Many small services calling each other; one slow service makes its callers slow too. | [config.ts](../src/shared/config.ts), [service.ts](../src/services/service.ts) |
| 2 | **Observability: logs vs metrics vs traces** | Logs say *what happened*, metrics say *how much*, traces say *where the time went in one request*. | [02 · Services & telemetry](02-services-and-telemetry.md) |
| 3 | **Distributed tracing** | A trace is a tree of spans, one per unit of work; spans from different processes join through a shared trace id. | [telemetry.ts](../src/shared/telemetry.ts) |
| 4 | **Context propagation (W3C `traceparent`)** | An HTTP header carrying the trace id and parent span id to the next service. | the `callDownstream` function in [service.ts](../src/services/service.ts) |
| 5 | **OpenTelemetry & OTLP** | The vendor-neutral standard for producing and shipping telemetry. SDK in the app, OTLP on the wire. | [telemetry.ts](../src/shared/telemetry.ts), [otlp.ts](../src/rca/otlp.ts) |
| 6 | **Span kinds (SERVER / CLIENT / INTERNAL)** | Tells you whether a span is "I received a call", "I made a call" or "I did local work". | [otlp.ts](../src/rca/otlp.ts), [analyze.ts](../src/rca/analyze.ts) |
| 7 | **Latency percentiles and tail latency** | p95/p99 describe the slowest requests, which averages hide. Users feel the tail. | `percentile()` in [stats.ts](../src/rca/stats.ts) |
| 8 | **Self time vs total time** | Total time includes waiting on others; self time is only the service's own work. This is how you stop blaming the caller. | [03 · Step 1](03-rca-engine.md#step-1-self-time) |
| 9 | **Critical path** | The chain of work that actually determines end-to-end latency; parallel branches that finish early don't count. | [03 · Step 5](03-rca-engine.md#step-5-critical-path-contribution) |
| 10 | **Anomaly detection with robust statistics** | Median and MAD instead of mean and standard deviation, so a few outliers can't hide an incident. | `robustZ()` in [analyze.ts](../src/rca/analyze.ts) |
| 11 | **Dependency graphs & cascading failures** | Slowness flows *upstream* from the faulty service to its callers; blame flows *downstream* to the deepest anomalous node. | [03 · Step 3](03-rca-engine.md#step-3-the-dependency-graph) |
| 12 | **Error propagation vs error origin** | A 502 in the caller is a symptom; the 500 in the callee is the cause. | `origin` in [analyze.ts](../src/rca/analyze.ts) |
| 13 | **Chaos engineering / fault injection** | Break things on purpose, in a controlled way, to prove your detection works. | [chaos.ts](../src/tools/chaos.ts), [04 · Chaos & evaluation](04-chaos-and-evaluation.md) |
| 14 | **Evaluating a detector** | Top-1 / top-3 accuracy, time to detect, false positives, and a naive baseline to beat. | [evaluate.ts](../src/tools/evaluate.ts) |
| 15 | **Sampling (head, tail and trace-ID based)** | You can't keep every trace. Deciding by a hash of the trace id keeps whole traces and needs no coordination. | `traceDice()` in [store.ts](../src/rca/store.ts), [06 · Sampling](06-production-guide.md#sampling-what-is-built) |
| 16 | **Node.js event loop** | CPU work blocks *every* request in that process, which is why `cpuBurnMs` hurts all concurrent calls. | `chaos.cpu_burn` in [service.ts](../src/services/service.ts) |

Keywords to search: *OpenTelemetry JS getting started*, *W3C trace context*, *RED method*, *USE method*,
*Google SRE book: monitoring distributed systems*, *tail latency at scale (Dean & Barroso)*,
*median absolute deviation*, *tail-based sampling*.

## Glossary

| Term | Meaning |
|---|---|
| **Span** | One timed unit of work (a request handled, a call made, a DB query). |
| **Trace** | All spans that belong to one end-to-end request, linked as a tree. |
| **Root cause** | The service where the problem *starts*, as opposed to services that only *show* it. |
| **Self time** | A server span's duration minus the time it spent waiting on downstream calls. |
| **Baseline** | What "normal" looks like, taken from the period just before the window being diagnosed. |
| **Origin error** | An error in a service that was *not* caused by an error in a service it called. |
| **p95 / p99** | The latency under which 95% / 99% of requests complete. |
| **MAD** | Median absolute deviation, a spread measure that ignores outliers. |
| **Delta temporality** | Each metric export reports only the change since the previous export. |

## Likely interview questions

<details><summary><b>Why compute self time instead of just looking at which service is slowest?</b></summary>

The slowest service is nearly always the one at the top of the call chain, because its duration *includes*
everything beneath it. In the evaluation, "blame the service with the highest p95" is right 0% of the time for exactly
this reason. Self time removes the time spent waiting on other services, so only the service that is
genuinely doing slow work stands out.
</details>

<details><summary><b>How do you handle parallel calls when computing self time?</b></summary>

It takes the *union* of the child CLIENT-span intervals, not their sum, then subtracts that from the
parent's duration. Two overlapping 20 ms calls cover 20 ms of waiting, not 40 ms.
See <code>unionLength()</code> in <a href="../src/rca/stats.ts">stats.ts</a>.
</details>

<details><summary><b>Why median/MAD instead of mean/standard deviation?</b></summary>

Latency data is skewed and spiky. A few slow requests inflate the mean and the standard deviation, which
makes the detector blind to the very thing it is looking for. The median and MAD barely move.
</details>

<details><summary><b>What if two services fail at the same time?</b></summary>

Both can be flagged as suspects, because each is judged on its *own* self time and origin errors. The
"leaf" signal discounts a service whose downstream dependency is also anomalous, so the deeper one ranks
higher, but both remain in the list. This is covered under limitations in the README.
</details>

<details><summary><b>What would break at real scale?</b></summary>

Memory (everything is in RAM), 100% sampling (you'd need tail-based sampling to keep the slow and failed
traces), clock skew between hosts (self time assumes parent and child clocks agree), and async or queue-based calls
that don't appear as a parent/child pair. Those are the next things to design.
</details>

<details><summary><b>How would you know the detector is any good?</b></summary>

Inject known faults and measure. That is the point of <code>npm run eval</code>: top-1/top-3 accuracy,
time to first correct ranking, false alarms on fault-free runs, and comparison with naive baselines.
</details>
