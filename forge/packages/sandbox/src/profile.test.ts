import { describe, expect, test } from "vitest";

import { resolveSandboxGrant } from "./profile.js";

describe("resolveSandboxGrant", () => {
  test("only grants capabilities and hosts allowed by every policy layer", () => {
    const result = resolveSandboxGrant([
      {
        capabilities: ["repository.read", "repository.write"],
        hosts: ["registry.npmjs.org", "api.github.com"],
      },
      { capabilities: ["repository.read"], hosts: ["registry.npmjs.org"] },
    ]);

    expect(result).toEqual({
      ok: true,
      value: {
        capabilities: ["repository.read"],
        hosts: ["registry.npmjs.org"],
      },
    });
  });

  test("fails closed when a required capability is not granted", () => {
    const result = resolveSandboxGrant([
      { capabilities: ["repository.write"], hosts: [] },
      { capabilities: ["repository.read"], hosts: [] },
    ]);

    expect(result).toEqual({
      ok: false,
      error: { code: "SANDBOX_GRANT_EMPTY" },
    });
  });
});
