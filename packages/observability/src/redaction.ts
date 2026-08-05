const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:api[-_]?key|password|secret|token)/i;
const SECRET_QUERY_VALUE = /((?:api[-_]?key|password|secret|token)=)[^&\s]+/gi;

/**
 * Fields that carry a person rather than a reference (011 §5.2). Forge runs
 * payroll workflows, so a member's wage or bank account reaching a trace is a
 * disclosure that no downstream access control undoes.
 *
 * Matched on whole key *words* rather than substrings, so `cardinality` is not
 * mistaken for a card number and `panelSize` is not mistaken for a member.
 */
const PII_WORDS: ReadonlySet<string> = new Set([
  "account",
  "address",
  "birth",
  "birthdate",
  "card",
  "compensation",
  "completion",
  "dob",
  "ein",
  "email",
  "employee",
  "iban",
  "itin",
  "member",
  "members",
  "phone",
  "routing",
  "salary",
  "ssn",
  "wage",
  "wages",
]);

/** `prompt` alone or `promptText` is content; `promptRef` is a name (011 §6.2). */
const PROMPT_BODY_WORDS: ReadonlySet<string> = new Set([
  "text",
  "body",
  "content",
]);

/**
 * Words that name a *person*. A principal never reaches a span: who decided
 * something belongs on the durable `ApprovalRecord`, and a trace only needs to
 * tell two deciders apart.
 *
 * The runtime already hashes the principal before it emits
 * `forge.approval.decided`, so this is the second line: an adapter cannot rely
 * on every present and future call site having remembered.
 */
const IDENTITY_WORDS: ReadonlySet<string> = new Set([
  "actor",
  "approver",
  "approvers",
  "decider",
  "principal",
  "requester",
  "subject",
  "user",
  "username",
]);

/**
 * What turns an identity key into a reference rather than a person.
 * `principalHash` and `approverCount` are exactly the attributes the taxonomy
 * asks for; `approverId` is not one of them, because a per-person identifier
 * still identifies the person.
 */
const IDENTITY_REFERENCE_WORDS: ReadonlySet<string> = new Set([
  "count",
  "hash",
  "ref",
]);

/** Values that are PII whatever the key is called. */
const VALUE_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // US SSN — the shape a payroll system leaks first.
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\bBearer\s+[\w.\-+/=]+/gi,
  /-----BEGIN[\s\S]*?-----END[^-]*-----/g,
];

function words(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase());
}

function isRedactedKey(key: string): boolean {
  if (SECRET_KEY.test(key)) return true;

  const parts = words(key);
  if (parts.some((part) => PII_WORDS.has(part))) return true;

  if (parts.some((part) => IDENTITY_WORDS.has(part))) {
    return !parts.some((part) => IDENTITY_REFERENCE_WORDS.has(part));
  }

  if (!parts.includes("prompt")) return false;
  return (
    parts.length === 1 || parts.some((part) => PROMPT_BODY_WORDS.has(part))
  );
}

function scrubString(value: string): string {
  return VALUE_PATTERNS.reduce(
    (scrubbed, pattern) => scrubbed.replace(pattern, REDACTED),
    value.replace(SECRET_QUERY_VALUE, `$1${REDACTED}`),
  );
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isRedactedKey(key) ? REDACTED : redact(nestedValue),
      ]),
    );
  }
  if (typeof value === "string") return scrubString(value);
  return value;
}

/**
 * Span attributes are flat scalars, so redaction preserves the shape exactly.
 * Kept separate from `redact` so the adapter recording a span does not have to
 * cast an `unknown` back into the port's attribute type.
 */
export function redactAttributes(
  attributes: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      isRedactedKey(key)
        ? REDACTED
        : typeof value === "string"
          ? scrubString(value)
          : value,
    ]),
  );
}
