import { describe, expect, test } from "vitest";

import { deepFreeze } from "./freeze.js";

describe("deepFreeze", () => {
  test("freezes nested objects and arrays", () => {
    const value = deepFreeze({ a: [{ b: 1 }], c: { d: [2] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a[0])).toBe(true);
    expect(Object.isFrozen(value.c.d)).toBe(true);
  });

  test("tolerates a cycle instead of recursing forever", () => {
    const node: { self?: unknown; name: string } = { name: "n" };
    node.self = node;
    expect(() => deepFreeze(node)).not.toThrow();
    expect(Object.isFrozen(node)).toBe(true);
  });

  test("returns primitives and null unchanged", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze("x")).toBe("x");
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });
});
