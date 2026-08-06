import { describe, expect, test } from "vitest";

import type { Connector, RawDelivery } from "./connector.js";
import {
  canPublish,
  createProgressAnnouncer,
  type ProgressUpdate,
  type PublishingConnector,
} from "./progress.js";
import { accept, reject } from "./request.js";

/**
 * Telling somebody about the work is not the work.
 *
 * Every property here is a way a third-party API takes a system down with it,
 * and 015 Phase 8's first exit criterion is that it cannot: a connector outage
 * must not lose canonical Forge state. The canonical state is in Postgres
 * before any of this runs, so what these tests actually guard is that nothing
 * here can reach back and disturb it — by throwing, by hanging, or by being
 * absent.
 */

const ORIGIN = {
  channel: "slack",
  externalId: "Ev0SYNTHETIC",
  externalActor: "U0SYNTHETIC",
  receivedAt: "2026-08-04T00:00:00.000Z",
} as const;

const UPDATE: ProgressUpdate = {
  origin: ORIGIN,
  runId: "run_1",
  status: "AWAITING_APPROVAL",
  pendingApprovalId: "approval_1",
  runUrl: "https://forge.internal/v1/runs/run_1",
};

/** A connector that only receives; most of the fields are not the subject. */
function connectorWith(
  publish?: (update: ProgressUpdate) => Promise<void>,
): Connector {
  const base: Connector = {
    channel: "slack",
    async verify(_delivery: RawDelivery) {
      return accept({ origin: ORIGIN, body: {} });
    },
    async normalise() {
      return reject("UNSUPPORTED", "not the subject of this file");
    },
  };
  if (publish === undefined) return base;
  const publishing: PublishingConnector = { ...base, publish };
  return publishing;
}

describe("a connector that cannot be reached costs a notification and nothing else", () => {
  test("an update reaches the connector for its own channel", () => {
    // The guard against every failure test below being vacuous: if nothing
    // were ever published, all of them would pass and the feature would be
    // an elaborate no-op.
    const seen: ProgressUpdate[] = [];
    const announcer = createProgressAnnouncer({
      connectors: {
        slack: connectorWith(async (update) => {
          seen.push(update);
        }),
      },
    });

    return announcer.announce(UPDATE).then((delivered) => {
      expect(seen).toEqual([UPDATE]);
      expect(delivered).toBe(true);
    });
  });

  test("a publisher that throws is not allowed to fail anything", async () => {
    /**
     * By the time this runs the run may already have dispatched a
     * customer-visible effect a human approved. Slack returning 500 must not
     * turn that into a failed run.
     */
    const failures: string[] = [];
    const announcer = createProgressAnnouncer({
      connectors: {
        slack: connectorWith(async () => {
          throw new Error("slack is having a day");
        }),
      },
      onFailure: (channel) => failures.push(channel),
    });

    // Swallowed rather than thrown — and reported as *not delivered*, which
    // is what lets a caller retry rather than lose it.
    await expect(announcer.announce(UPDATE)).resolves.toBe(false);
    expect(failures).toEqual(["slack"]);
  });

  test("a publisher that never answers is bounded rather than waited on", async () => {
    /**
     * Worse than one that refuses, because a hang has no error to fail open
     * on. This system has been bitten by exactly this twice already, in
     * `QueuePort.health()` and in its `close()`.
     */
    const announcer = createProgressAnnouncer({
      connectors: {
        slack: connectorWith(() => new Promise<void>(() => {})),
      },
      timeoutMs: 50,
    });

    const started = Date.now();
    // A timeout is not a slow success. Whether it landed is unknowable, and
    // the only safe reading of "we never heard" is that it did not.
    await expect(announcer.announce(UPDATE)).resolves.toBe(false);

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a publisher that throws before it returns a promise also fails open", async () => {
    /**
     * Distinct from a rejected promise, and reachable: a client library that
     * validates its arguments throws synchronously, before any promise
     * exists. The `finally` then runs with no timer to clear, which is the
     * one arm of this function a rejected promise never reaches.
     */
    const failures: string[] = [];
    const base = connectorWith(async () => {});
    const throwing: Connector = {
      ...base,
      publish() {
        throw new TypeError("channel id is required");
      },
    } as Connector;

    const announcer = createProgressAnnouncer({
      connectors: { slack: throwing },
      onFailure: (channel) => failures.push(channel),
    });

    await expect(announcer.announce(UPDATE)).resolves.toBe(false);
    expect(failures).toEqual(["slack"]);
  });

  test("a channel with no connector bound is delivered, not deferred", async () => {
    /**
     * A run started at the API has nobody to tell — the ordinary case, not a
     * misconfiguration. Reported as delivered on purpose: there was nothing
     * to deliver, and calling it a failure would put a retry on the queue
     * that repeats forever over a channel nobody bound.
     */
    const announcer = createProgressAnnouncer({ connectors: {} });

    await expect(announcer.announce(UPDATE)).resolves.toBe(true);
  });

  test("a connector that only receives is not asked to publish", async () => {
    const announcer = createProgressAnnouncer({
      connectors: { slack: connectorWith() },
    });

    await expect(announcer.announce(UPDATE)).resolves.toBe(true);
    expect(canPublish(connectorWith())).toBe(false);
  });
});

describe("what a connector may say back", () => {
  test("the update has nowhere to put a payload", () => {
    /**
     * Redacted by construction rather than by a scrubber. This lands in a
     * Slack channel or a Jira comment that a great many people can read, and
     * a filter is a thing to forget — a shape with nowhere to put a payload
     * cannot leak one.
     *
     * Asserted over the keys rather than by reading the type, so the day
     * somebody adds `result` or `input` for convenience, this is what stops
     * them.
     */
    expect(Object.keys(UPDATE).sort()).toEqual([
      "origin",
      "pendingApprovalId",
      "runId",
      "runUrl",
      "status",
    ]);
  });

  test("what it carries is a link, not what is behind it", () => {
    // The details live in Forge, behind Forge's authentication. A connector
    // posts somewhere to look, never a summary of what it found there.
    expect(UPDATE.runUrl).toContain(UPDATE.runId);
    expect(JSON.stringify(UPDATE)).not.toContain("the copy");
  });
});
