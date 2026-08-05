import { describe, expect, test } from "vitest";

import { satisfiesRange } from "./version.js";

describe("satisfiesRange", () => {
  test("an exact range matches only that version", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });

  test("a caret on a 1.x range allows minor and patch above it", () => {
    expect(satisfiesRange("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfiesRange("1.2.0", "^1.2.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesRange("1.1.9", "^1.2.0")).toBe(false);
  });

  test("a caret on a 0.x range is confined to the minor", () => {
    // Pre-1.0.0 a minor bump is breaking, which is how npm reads a caret here.
    expect(satisfiesRange("0.1.5", "^0.1.0")).toBe(true);
    expect(satisfiesRange("0.2.0", "^0.1.0")).toBe(false);
  });

  test("a tilde range is confined to the patch", () => {
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
  });

  test("a >= range is open above", () => {
    expect(satisfiesRange("9.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("0.9.0", ">=1.0.0")).toBe(false);
  });

  test("an unparseable range is not satisfied", () => {
    // Fails closed. Shrugging at a range it cannot read would admit exactly the
    // incompatible plugin the check exists to keep out.
    for (const range of ["latest", "*", "", "1.x", "^1", ">1.0.0", "1.0"]) {
      expect(satisfiesRange("1.0.0", range)).toBe(false);
    }
  });

  test("an unparseable version is not satisfied either", () => {
    expect(satisfiesRange("next", "^1.0.0")).toBe(false);
  });
});
