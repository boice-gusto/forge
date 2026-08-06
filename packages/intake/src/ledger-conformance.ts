import { describe, expect, test } from "vitest";

import type { IntakeLedgerPort } from "./connector.js";

/**
 * The contract every intake ledger holds, whatever it remembers with.
 *
 * There is exactly one property here that matters and it is not "it
 * remembers": it is that **only one caller is ever told yes**. A ledger that
 * loses its memory accepts a delivery twice, which is one Slack shortcut
 * becoming two customer-visible runs. A ledger that answers `false` too
 * eagerly drops a real request, which is recoverable — the sender retries.
 *
 * So the tests below are mostly about the first `true`, and about it being
 * the only one.
 */
export interface IntakeLedgerConformanceHarness {
  readonly name: string;
  /** A ledger with nothing in it. */
  create(): Promise<{
    readonly ledger: IntakeLedgerPort;
    /**
     * A second handle onto the same storage — what a second process has. For
     * an in-process ledger this is the same object, and the suite says so
     * rather than pretending otherwise.
     */
    peer(): Promise<IntakeLedgerPort>;
  }>;
  /**
   * Whether this ledger is shared between processes. An in-memory one is not,
   * and the cross-process test is skipped for it *loudly* rather than passing
   * on a claim it cannot make.
   */
  readonly sharedAcrossProcesses: boolean;
}

export function describeIntakeLedgerConformance(
  harness: IntakeLedgerConformanceHarness,
): void {
  describe(`${harness.name} · IntakeLedgerPort conformance`, () => {
    test("a delivery nobody has seen is claimed", async () => {
      const { ledger } = await harness.create();

      expect(await ledger.claim("slack", "Ev0FIRST")).toBe(true);
    });

    test("the second claim on the same delivery is refused", async () => {
      const { ledger } = await harness.create();
      await ledger.claim("slack", "Ev0REPEAT");

      expect(await ledger.claim("slack", "Ev0REPEAT")).toBe(false);
    });

    test("the same id on a different channel is a different delivery", async () => {
      // Ids are only unique within the system that issued them. Keying on the
      // id alone would let a Jira webhook suppress a Slack event that happened
      // to share a number.
      const { ledger } = await harness.create();
      await ledger.claim("slack", "1001");

      expect(await ledger.claim("jira", "1001")).toBe(true);
    });

    test("different deliveries on one channel are independent", async () => {
      // Guards the test above: a ledger that claimed *everything* once and
      // then refused would pass "the second is refused" and drop every
      // subsequent request.
      const { ledger } = await harness.create();
      await ledger.claim("slack", "Ev0ONE");

      expect(await ledger.claim("slack", "Ev0TWO")).toBe(true);
    });

    test("a fresh ledger has no memory of another's claims", async () => {
      // Guards the suite: if `create()` handed back shared state, every test
      // above would be reading the previous one's leftovers.
      const first = await harness.create();
      await first.ledger.claim("slack", "Ev0ISOLATED");
      const second = await harness.create();

      expect(await second.ledger.claim("slack", "Ev0ISOLATED")).toBe(true);
    });

    test("many concurrent claims on one delivery yield exactly one winner", async () => {
      /**
       * The property the whole port exists for, and the one a check-then-write
       * implementation fails. Two workers behind a load balancer receive the
       * same Slack retry in the same millisecond; if both are told yes, the
       * customer gets the workflow twice.
       *
       * Run against one handle here and across handles below, because an
       * implementation can get this right in-process and wrong in the
       * database, and those are different bugs.
       */
      const { ledger } = await harness.create();

      const answers = await Promise.all(
        Array.from({ length: 12 }, () => ledger.claim("slack", "Ev0RACE")),
      );

      expect(answers.filter(Boolean)).toHaveLength(1);
    });

    test.skipIf(!harness.sharedAcrossProcesses)(
      "a second process cannot claim what the first already did",
      async () => {
        /**
         * Skipped, loudly, for an in-process ledger — which cannot make this
         * claim and should not appear to. That is the difference between the
         * memory adapter and a deployable one, and it is the reason the memory
         * one says so in its own doc comment.
         */
        const { ledger, peer } = await harness.create();
        const other = await peer();
        await ledger.claim("slack", "Ev0CROSS");

        expect(await other.claim("slack", "Ev0CROSS")).toBe(false);
      },
    );

    test.skipIf(!harness.sharedAcrossProcesses)(
      "two processes racing one delivery yield exactly one winner",
      async () => {
        const { ledger, peer } = await harness.create();
        const other = await peer();

        const answers = await Promise.all([
          ledger.claim("slack", "Ev0CROSSRACE"),
          other.claim("slack", "Ev0CROSSRACE"),
          ledger.claim("slack", "Ev0CROSSRACE"),
          other.claim("slack", "Ev0CROSSRACE"),
        ]);

        expect(answers.filter(Boolean)).toHaveLength(1);
      },
    );
  });
}
