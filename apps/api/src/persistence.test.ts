import { describe, expect, test } from "vitest";

import { persistenceFrom } from "./persistence.js";

describe("which composition root a deployment runs on", () => {
  test("postgres selects the durable root", () => {
    expect(persistenceFrom("postgres")).toBe("postgres");
  });

  test("absent, empty, or the explicit memory keeps the in-memory root", () => {
    // A contributor with no container runtime still gets a control plane.
    expect(persistenceFrom(undefined)).toBe("memory");
    expect(persistenceFrom("")).toBe("memory");
    expect(persistenceFrom("memory")).toBe("memory");
  });

  test("anything else stops the boot rather than defaulting", () => {
    // The failure this exists to prevent fails *open*: a deployment that meant
    // to be durable and quietly was not looks perfectly healthy right up until
    // a restart empties the run list.
    expect(() => persistenceFrom("Postgres")).toThrow(/FORGE_PERSISTENCE/);
    expect(() => persistenceFrom("pg")).toThrow(/"memory" or "postgres"/);
  });
});
