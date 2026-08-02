export type ValueSources<Value> = {
  readonly cli?: Value;
  readonly environment?: Value;
  readonly local?: Value;
  readonly configured?: Value;
  readonly fallback: Value;
};

export type ResolvedValue<Value> = {
  readonly source: "cli" | "environment" | "local" | "configured" | "fallback";
  readonly value: Value;
};

export function resolveValue<Value>(
  sources: ValueSources<Value>,
): ResolvedValue<Value> {
  if (sources.cli !== undefined) return { source: "cli", value: sources.cli };
  if (sources.environment !== undefined)
    return { source: "environment", value: sources.environment };
  if (sources.local !== undefined)
    return { source: "local", value: sources.local };
  if (sources.configured !== undefined)
    return { source: "configured", value: sources.configured };
  return { source: "fallback", value: sources.fallback };
}
