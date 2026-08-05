export {
  parseHeaders,
  resolveHeaders,
  resolveServiceName,
  resolveTracesEndpoint,
} from "./environment.js";
export {
  createOtelObservability,
  type OtelObservability,
  type OtelObservabilityOptions,
  TELEMETRY_KIND_ATTRIBUTE,
} from "./observability.js";
