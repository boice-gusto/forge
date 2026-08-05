export type Environment = Readonly<Record<string, string | undefined>>;

const TRACES_PATH = "/v1/traces";

/**
 * Where traces go, from the environment and nowhere else.
 *
 * There is no built-in default, for the same reason the durable stack has no
 * default database URL: a default endpoint is an endpoint that lives in the
 * repository, and the moment one exists somebody adds the token that goes with
 * it. A composition root that meant to export and did not configure one should
 * hear about it at boot, not discover months later that nothing was collected.
 *
 * Names follow the OTLP exporter specification, so an operator configures Forge
 * the way they configure every other OpenTelemetry process.
 */
export function resolveTracesEndpoint(
  env: Environment,
  supplied?: string,
): string {
  const explicit = supplied ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (explicit !== undefined && explicit !== "") return explicit;

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (base !== undefined && base !== "") {
    return `${base.replace(/\/+$/, "")}${TRACES_PATH}`;
  }

  throw new Error(
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is not set. The OpenTelemetry adapter " +
      "reads its destination from the environment; there is no built-in " +
      "default, because a default would mean an endpoint lived in the " +
      "repository. Set OTEL_EXPORTER_OTLP_ENDPOINT for the whole process, or " +
      "pass an exporter explicitly.",
  );
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` per the specification: comma-separated
 * `key=value`, values percent-encoded. This is where a collector's auth token
 * arrives, which is precisely why it is read rather than written down.
 *
 * A malformed entry is dropped rather than thrown on: a header the operator
 * mistyped must not be the reason a payroll run refuses to start.
 */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};

  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key === "") continue;
    headers[key] = decodeValue(entry.slice(separator + 1).trim());
  }
  return headers;
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveHeaders(
  env: Environment,
  supplied: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    ...supplied,
  };
}

export function resolveServiceName(
  env: Environment,
  supplied?: string,
): string {
  const name = supplied ?? env.OTEL_SERVICE_NAME;
  return name === undefined || name === "" ? "forge" : name;
}
