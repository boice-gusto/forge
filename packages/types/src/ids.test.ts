import { describe, expect, test } from "vitest";

import { createRunId } from "./ids.js";

describe("createRunId", () => {
  test("returns a branded Forge run identifier", () => {
    expect(createRunId("run_123")).toBe("run_123");
  });

  test("rejects an empty run identifier", () => {
    expect(() => createRunId("")).toThrow("Run ID must not be empty");
  });
});
