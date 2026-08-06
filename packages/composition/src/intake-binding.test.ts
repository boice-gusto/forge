import type { Connector } from "@forge/intake";
import { accept, reject } from "@forge/intake";
import type { Pool } from "pg";
import { describe, expect, test } from "vitest";

import { bindIntake, environmentSecret } from "./intake-binding.js";

/**
 * What a deployment gets when it binds channels, and what it gets when it
 * cannot.
 *
 * `apps/api` and `apps/worker` both call this, and the reason it is one
 * function rather than one per binary is that they must not disagree: an API
 * serving a channel the worker cannot announce back to is a run nobody hears
 * about, and a worker serving one the API refuses is a webhook that 404s.
 */

const slack: Connector = {
  channel: "slack",
  async verify() {
    return accept({
      origin: {
        channel: "slack",
        externalId: "1",
        externalActor: "u",
        receivedAt: "2026-08-04T00:00:00.000Z",
      },
      body: {},
    });
  },
  async normalise() {
    return reject("UNSUPPORTED", "not the subject of this file");
  },
};

const refused = (problems: readonly string[]): never => {
  throw new Error(`refused: ${problems.join("; ")}`);
};

describe("binding the channels a deployment serves", () => {
  test("a company that binds no connectors gets no intake, and that is fine", () => {
    // The default. A deployment that has not thought about webhooks does not
    // have one, and that is not a misconfiguration to warn about.
    expect(bindIntake(undefined, undefined, refused)).toBeUndefined();
  });

  test("a factory's channels are bound", () => {
    const bound = bindIntake(
      { default: () => ({ slack }) },
      undefined,
      refused,
    );

    expect(Object.keys(bound?.connectors ?? {})).toEqual(["slack"]);
  });

  test("a problem stops the boot rather than serving half the channels", () => {
    /**
     * A control plane that started with half its channels answers 404 on a
     * webhook somebody configured, which looks like the sender's fault and is
     * not. The decision to stop belongs to the binary — this hands it the
     * reasons — and both binaries do stop.
     */
    expect(() =>
      bindIntake(
        { default: () => ({ slack: { nope: true } }) },
        undefined,
        refused,
      ),
    ).toThrow("'slack' is not a connector");
  });

  test("with a database the ledger reaches it; without one it does not", async () => {
    /**
     * The difference between deduplicating and appearing to. Two control
     * planes each holding their own `Set` each accept the same webhook retry
     * once — which is twice, which is one customer-visible workflow running
     * again.
     *
     * Asserted by *where the claim goes*, not by the two ledgers being
     * different objects — which they are even when both are in-process, so
     * that version of this test passed with the durable one removed
     * altogether.
     */
    const queries: string[] = [];
    const recording = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [{ claimed: 1 }] };
      },
    } as unknown as Pool;

    const withDatabase = bindIntake(
      { default: () => ({ slack }) },
      recording,
      refused,
    );
    await withDatabase?.ledger.claim("slack", "Ev0DURABLE");
    expect(queries.join(" ")).toContain("forge_intake");

    const withoutDatabase = bindIntake(
      { default: () => ({ slack }) },
      undefined,
      refused,
    );
    await withoutDatabase?.ledger.claim("slack", "Ev0LOCAL");
    // Still one: the in-process ledger reached no database at all.
    expect(queries).toHaveLength(1);
  });

  test("secrets are read from the environment, never from the company", () => {
    // The whole reason the company exports a factory rather than a table: a
    // table could only exist if the secrets were already in the package.
    const name = ["FORGE", "TEST", "INTAKE", "LOOKUP"].join("_");
    expect(environmentSecret(name)).toBeUndefined();

    process.env[name] = "from-the-host";
    try {
      expect(environmentSecret(name)).toBe("from-the-host");
    } finally {
      delete process.env[name];
    }
  });
});
