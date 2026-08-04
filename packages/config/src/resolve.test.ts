import { describe, expect, test } from "vitest";

import { resolveValue } from "./resolve.js";

describe("resolveValue", () => {
  test("prefers a CLI value over all lower-precedence sources", () => {
    expect(
      resolveValue({
        cli: "cli",
        environment: "env",
        local: "local",
        configured: "config",
        fallback: "default",
      }),
    ).toEqual({ source: "cli", value: "cli" });
  });

  test("uses the safe fallback when no explicit source is set", () => {
    expect(resolveValue({ fallback: "mock" })).toEqual({
      source: "fallback",
      value: "mock",
    });
  });
});
