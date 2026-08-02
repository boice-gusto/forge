import { describe, expect, test } from "vitest";

import { redact } from "./redaction.js";

describe("redact", () => {
  test("redacts nested secret fields without changing safe fields", () => {
    expect(
      redact({ apiKey: "secret", nested: { token: "hidden", runId: "run_1" } }),
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]", runId: "run_1" },
    });
  });
});
