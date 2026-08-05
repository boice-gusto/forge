import { describe, expect, test, vi } from "vitest";

import { decideRuntimeRequirement } from "./runtime-required.js";

describe("an unverified durable store must not read as green", () => {
  test("a reachable runtime simply runs, and says nothing", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(decideRuntimeRequirement("approval-postgres", true, false)).toBe(
      true,
    );
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  test("without a runtime the suite skips, but says so on stderr", () => {
    // Local development must not need Docker. The skip is only honest if the
    // reason is visible, and vitest's default reporter swallows console.warn
    // from module scope.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(decideRuntimeRequirement("approval-postgres", false, false)).toBe(
      false,
    );
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("UNVERIFIED");
    stderr.mockRestore();
  });

  test("when stores are required, skipping is a failure", () => {
    // CI sets FORGE_REQUIRE_STORES=1: a skip is invisible in a run summary, so
    // it must not be a way for an unverified adapter to pass.
    expect(() =>
      decideRuntimeRequirement("checkpoint-postgres", false, true),
    ).toThrow(/not permitted/);
  });

  test("the failure names the adapter left unverified", () => {
    expect(() =>
      decideRuntimeRequirement("checkpoint-postgres", false, true),
    ).toThrow(/checkpoint-postgres/);
  });
});
