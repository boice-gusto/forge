const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:api[-_]?key|password|secret|token)/i;
const SECRET_QUERY_VALUE = /((?:api[-_]?key|password|secret|token)=)[^&\s]+/gi;

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
  if (typeof value === "string") {
    return value.replace(SECRET_QUERY_VALUE, `$1${REDACTED}`);
  }
  return value;
}
