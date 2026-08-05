import { describe, expect, test } from "vitest";

import { redact, redactAttributes } from "./redaction.js";

describe("redact", () => {
  test("redacts nested secret fields without changing safe fields", () => {
    expect(
      redact({ apiKey: "secret", nested: { token: "hidden", runId: "run_1" } }),
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]", runId: "run_1" },
    });
  });

  test("redacts a secret carried in a query string value", () => {
    expect(redact("https://x.test/cb?api_key=abc123&page=2")).toBe(
      "https://x.test/cb?api_key=[REDACTED]&page=2",
    );
  });

  test("walks arrays rather than stopping at the first object", () => {
    expect(redact([{ password: "p" }, { runId: "run_2" }])).toEqual([
      { password: "[REDACTED]" },
      { runId: "run_2" },
    ]);
  });

  test("leaves non-string scalars alone", () => {
    expect(redact({ attempt: 3, ok: true, missing: null })).toEqual({
      attempt: 3,
      ok: true,
      missing: null,
    });
  });
});

/**
 * Forge runs payroll workflows. A trace that carried a member's identity would
 * be a disclosure that no amount of downstream access control undoes, so the
 * scrub happens before the record exists.
 */
describe("payroll data never survives redaction", () => {
  test("member-identifying keys are replaced, not merely hashed", () => {
    expect(
      redact({
        ssn: "123-45-6789",
        member_id: "m_88",
        employeeId: "e_12",
        bank: { accountNumber: "000123456", routing: "021000021" },
        annualSalary: 82000,
        "user.email": "ada@example.test",
      }),
    ).toEqual({
      ssn: "[REDACTED]",
      member_id: "[REDACTED]",
      employeeId: "[REDACTED]",
      bank: { accountNumber: "[REDACTED]", routing: "[REDACTED]" },
      annualSalary: "[REDACTED]",
      "user.email": "[REDACTED]",
    });
  });

  test("a value that is PII is scrubbed even under an innocent key", () => {
    expect(
      redact({
        note: "contact ada@example.test about 123-45-6789",
        auth: "Bearer eyJhbGciOi.J9.sig",
      }),
    ).toEqual({
      note: "contact [REDACTED] about [REDACTED]",
      auth: "[REDACTED]",
    });
  });

  test("a PEM block is removed whole rather than truncated", () => {
    expect(
      redact("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"),
    ).toBe("[REDACTED]");
  });

  test("prompt content is banned while a prompt reference is not", () => {
    expect(
      redact({
        prompt: "Summarise the payroll for Ada",
        promptRef: "acme.publish.draft@1",
        promptVersion: "1.2.0",
      }),
    ).toEqual({
      prompt: "[REDACTED]",
      promptRef: "acme.publish.draft@1",
      promptVersion: "1.2.0",
    });
  });
});

describe("redactAttributes keeps a span's shape while scrubbing it", () => {
  test("scalars stay scalar and identifiers stay readable", () => {
    expect(
      redactAttributes({
        runId: "run_1",
        nodeId: "publish",
        attempt: 2,
        replayed: true,
      }),
    ).toEqual({
      runId: "run_1",
      nodeId: "publish",
      attempt: 2,
      replayed: true,
    });
  });

  test("a sensitive attribute is redacted by key and by value", () => {
    expect(
      redactAttributes({
        approverEmail: "ada@example.test",
        reason: "asked ada@example.test to confirm",
        wage: 1200,
      }),
    ).toEqual({
      approverEmail: "[REDACTED]",
      reason: "asked [REDACTED] to confirm",
      wage: "[REDACTED]",
    });
  });
});
