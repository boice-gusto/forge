import { describe, expect, test } from "vitest";

import {
  acceptDelivery,
  type Connector,
  type RawDelivery,
} from "./connector.js";
import { createMemoryIntakeLedger } from "./ledger-memory.js";

/**
 * The contract every intake adapter proves itself against (015 Phase 8).
 *
 * A connector is the only part of Forge with an unauthenticated caller on the
 * other side of it, so the properties here are not about convenience. Three of
 * them are about what must *not* happen — an unsigned delivery becoming a run,
 * a redelivery becoming a second run, an unrelated event becoming anything —
 * and a suite that only checked the happy path would pass on a connector that
 * accepted everything.
 *
 * A new connector calls this with its own factory rather than hand-copying
 * another's tests and drifting from them.
 */
export interface ConnectorConformanceHarness {
  readonly name: string;
  /** A connector wired to whatever secret the fixtures below are signed with. */
  create(): Connector | Promise<Connector>;
  /** A delivery this connector should accept, signed correctly. */
  valid(): RawDelivery | Promise<RawDelivery>;
  /**
   * The same delivery with its signature or token broken, and *only* that —
   * a fixture that also changed the body would pass this suite while proving
   * the body check rather than the signature check.
   */
  forged(): RawDelivery | Promise<RawDelivery>;
  /**
   * Correctly signed, and not something this connector turns into a run: the
   * ordinary traffic of a busy workspace.
   */
  irrelevant(): RawDelivery | Promise<RawDelivery>;
  /** The external id `valid()` carries, so deduplication can be asserted. */
  externalIdOfValid(): string | Promise<string>;
}

export function describeConnectorConformance(
  harness: ConnectorConformanceHarness,
): void {
  describe(`${harness.name} · Connector conformance`, () => {
    const fresh = async () => ({
      connector: await harness.create(),
      ledger: createMemoryIntakeLedger(),
    });

    describe("nothing unverified becomes a request", () => {
      test("a forged delivery is rejected, and rejected as unverified", async () => {
        // The code matters as much as the refusal: an operator counting
        // UNVERIFIED is watching for an attack, and one counting MALFORMED is
        // watching for a bad integration. A connector that verified by
        // failing to parse would report the wrong one.
        const { connector, ledger } = await fresh();

        const outcome = await acceptDelivery(
          connector,
          ledger,
          await harness.forged(),
        );

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe("UNVERIFIED");
      });

      test("a forged delivery does not consume the id it claims", async () => {
        /**
         * Otherwise an unauthenticated caller silences a real event by
         * guessing its id: send a forged delivery naming it, the ledger marks
         * it seen, and the genuine one arrives to find itself a duplicate.
         * This is why deduplication happens *after* verification and not
         * before.
         */
        const { connector, ledger } = await fresh();
        await acceptDelivery(connector, ledger, await harness.forged());

        const outcome = await acceptDelivery(
          connector,
          ledger,
          await harness.valid(),
        );

        expect(`after a forgery: ${JSON.stringify(outcome)}`).toContain(
          '"ok":true',
        );
      });

      test("verification does not depend on the body being parseable", async () => {
        // A JSON parser is a lot of code to put in front of an
        // unauthenticated caller. Whatever this returns, it must not throw.
        const { connector } = await fresh();
        const garbage: RawDelivery = {
          body: "{not json at all",
          headers: (await harness.forged()).headers,
        };

        await expect(connector.verify(garbage)).resolves.toMatchObject({
          ok: false,
        });
      });
    });

    describe("one delivery is one request, however many times it arrives", () => {
      test("a valid delivery is accepted and names its channel", async () => {
        const { connector, ledger } = await fresh();

        const outcome = await acceptDelivery(
          connector,
          ledger,
          await harness.valid(),
        );

        expect(`accepted: ${JSON.stringify(outcome)}`).toContain('"ok":true');
        if (!outcome.ok) return;
        expect(outcome.value.origin.channel).toBe(connector.channel);
        expect(outcome.value.origin.externalId).toBe(
          await harness.externalIdOfValid(),
        );
        // Recorded as the sending system names them, not as a Forge
        // principal: mapping one onto the other is an authorisation decision
        // and it is not a connector's to make.
        expect(outcome.value.origin.externalActor).not.toBe("");
      });

      test("the same delivery twice is one request and one duplicate", async () => {
        // Every webhook in production redelivers, usually while something
        // else is already on fire.
        const { connector, ledger } = await fresh();

        const first = await acceptDelivery(
          connector,
          ledger,
          await harness.valid(),
        );
        const second = await acceptDelivery(
          connector,
          ledger,
          await harness.valid(),
        );

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        expect(second.ok === false && second.code).toBe("DUPLICATE");
      });

      test("a fresh ledger accepts it again, so the refusal is the ledger's", async () => {
        // Guards the test above: a connector that rejected every second call
        // for a reason of its own would pass it and deduplicate nothing.
        const connector = await harness.create();

        const first = await acceptDelivery(
          connector,
          createMemoryIntakeLedger(),
          await harness.valid(),
        );
        const second = await acceptDelivery(
          connector,
          createMemoryIntakeLedger(),
          await harness.valid(),
        );

        expect([first.ok, second.ok]).toEqual([true, true]);
      });
    });

    describe("a connector says what it does not handle", () => {
      test("an unrelated event is UNSUPPORTED, not an error and not a run", async () => {
        // Most events in a busy workspace are not asking Forge for anything.
        // Treating that as a failure would make the logs useless on the day
        // one of them is a real failure.
        const { connector, ledger } = await fresh();

        const outcome = await acceptDelivery(
          connector,
          ledger,
          await harness.irrelevant(),
        );

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe("UNSUPPORTED");
      });
    });

    describe("a connector cannot speak for another channel", () => {
      test("an origin naming someone else's channel is refused", async () => {
        /**
         * A connector that could stamp another channel's name on a delivery
         * could deduplicate against that channel's ids and suppress its
         * events. Enforced by `acceptDelivery` rather than trusted, because
         * the check costs nothing and the failure is silent.
         */
        const connector = await harness.create();
        const impostor: Connector = {
          channel: connector.channel,
          async verify(delivery) {
            const verified = await connector.verify(delivery);
            if (!verified.ok) return verified;
            return {
              ok: true,
              value: {
                ...verified.value,
                origin: { ...verified.value.origin, channel: "somewhere-else" },
              },
            };
          },
          normalise: connector.normalise.bind(connector),
        };

        const outcome = await acceptDelivery(
          impostor,
          createMemoryIntakeLedger(),
          await harness.valid(),
        );

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe("MALFORMED");
      });
    });
  });
}
