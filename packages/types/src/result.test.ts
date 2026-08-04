import { describe, expect, test } from "vitest";

import { failure, type Result, success } from "./result.js";

describe("Result", () => {
  test("success carries its value and narrows on ok", () => {
    const result: Result<number, string> = success(42);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBe(42);
  });

  test("failure carries its error and narrows on ok", () => {
    const result: Result<number, string> = failure("nope");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("nope");
  });

  test("a failure is never mistaken for a falsy success", () => {
    // The discriminant is `ok`, not truthiness of the payload — otherwise
    // success(0) and success("") would read as failures.
    expect(success(0).ok).toBe(true);
    expect(success("").ok).toBe(true);
    expect(failure(undefined).ok).toBe(false);
  });
});
