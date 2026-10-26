// Must be the FIRST import of a service entrypoint: the HTTP instrumentation patches
// node:http when it is first required, so it has to be registered before anything uses it.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter, AggregationTemporalityPreference } from "@opentelemetry/exporter-metrics-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { RCA_URL } from "./config";

const serviceName = process.env.SERVICE_NAME ?? "unknown";
const endpoint = process.env.OTLP_ENDPOINT ?? RCA_URL;

const sdk = new NodeSDK({
  resource: new Resource({ "service.name": serviceName }),
  // Traces: flush every 500ms so the RCA engine sees incidents with sub-second lag.
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }), {
      scheduledDelayMillis: 500,
      maxExportBatchSize: 512,
    }),
  ],
  // Metrics: DELTA temporality means each export carries only "what happened since the last one".
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      temporalityPreference: AggregationTemporalityPreference.DELTA,
    }),
    exportIntervalMillis: 2000,
  }),
  instrumentations: [
    new HttpInstrumentation({
      // Don't trace our own telemetry/log shipping or the control endpoints.
      ignoreOutgoingRequestHook: (req) => String(req.path ?? "").startsWith("/v1/") || String(req.path ?? "").startsWith("/ingest/"),
      ignoreIncomingRequestHook: (req) => (req.url ?? "").startsWith("/chaos") || (req.url ?? "").startsWith("/health"),
    }),
    // Real database calls become CLIENT spans carrying db.system = postgresql | redis.
    new PgInstrumentation(),
    new IORedisInstrumentation(),
  ],
});

sdk.start();

export const shutdownTelemetry = () => sdk.shutdown();
