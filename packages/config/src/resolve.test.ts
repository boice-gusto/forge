import { describe, expect, test } from "vitest";

import { resolveValue } from "./resolve.js";

/**
 * Precedence is the whole contract here, so each level is asserted against
 * the one below it rather than in isolation — a test that only checks "cli
 * wins" would still pass if the lower levels were in the wrong order.
 */
describe("configuration precedence", () => {
  test("cli beats every other source", () => {
    expect(
      resolveValue({
        cli: "cli",
        environment: "env",
        local: "local",
        configured: "configured",
        fallback: "fallback",
      }),
    ).toEqual({ source: "cli", value: "cli" });
  });

  test("environment beats local, configured and fallback", () => {
    expect(
      resolveValue({
        environment: "env",
        local: "local",
        configured: "configured",
        fallback: "fallback",
      }),
    ).toEqual({ source: "environment", value: "env" });
  });

  test("local beats configured and fallback", () => {
    expect(
      resolveValue({
        local: "local",
        configured: "configured",
        fallback: "fallback",
      }),
    ).toEqual({ source: "local", value: "local" });
  });

  test("configured beats fallback", () => {
    expect(
      resolveValue({ configured: "configured", fallback: "fallback" }),
    ).toEqual({ source: "configured", value: "configured" });
  });

  test("fallback is used only when nothing else is set", () => {
    expect(resolveValue({ fallback: "fallback" })).toEqual({
      source: "fallback",
      value: "fallback",
    });
  });

  test("the source is reported, so an operator can see where a value came from", () => {
    expect(resolveValue({ environment: 1, fallback: 0 }).source).toBe(
      "environment",
    );
  });

  test("a falsy value still counts as set", () => {
    // Guarding on `!== undefined` rather than truthiness: 0, "" and false are
    // legitimate configuration values.
    expect(resolveValue({ cli: 0, fallback: 99 })).toEqual({
      source: "cli",
      value: 0,
    });
    expect(resolveValue({ environment: false, fallback: true })).toEqual({
      source: "environment",
      value: false,
    });
  });
});
