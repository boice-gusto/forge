type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type RunId = Brand<string, "RunId">;

export function createRunId(value: string): RunId {
  if (value.trim().length === 0) {
    throw new Error("Run ID must not be empty");
  }

  return value as RunId;
}
