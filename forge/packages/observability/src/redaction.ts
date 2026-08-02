const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:api[-_]?key|password|secret|token)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : redact(nestedValue),
      ]),
    );
  }
  return value;
}
