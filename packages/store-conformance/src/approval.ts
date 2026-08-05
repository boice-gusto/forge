import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalStatus,
} from "@forge/ports";
import { createFixedClock, createSequentialIds } from "@forge/ports";
import { describe, expect, test } from "vitest";

import {
  type ApprovalConformanceHarness,
  CONFORMANCE_APPROVAL,
  CONFORMANCE_NOW,
  type StoreHandle,
} from "./harness.js";

function open(
  harness: ApprovalConformanceHarness,
): Promise<StoreHandle<ApprovalPort>> {
  return harness.create(
    createFixedClock(CONFORMANCE_NOW),
    createSequentialIds(),
  );
}

async function store(
  harness: ApprovalConformanceHarness,
): Promise<ApprovalPort> {
  return (await open(harness)).store;
}

const DECISIONS: readonly (readonly [ApprovalDecision, ApprovalStatus])[] = [
  [{ kind: "approve" }, "APPROVED"],
  [{ kind: "reject", reason: "no" }, "REJECTED"],
  [{ kind: "edit", patch: {} }, "EDITED"],
  [{ kind: "timeout" }, "TIMED_OUT"],
];

function describeBinding(harness: ApprovalConformanceHarness): void {
  describe("an approval binds to one exact action", () => {
    test("the request is stored whole and starts pending", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      expect(approval).toMatchObject(CONFORMANCE_APPROVAL);
      expect(approval.status).toBe("PENDING");
      expect(approval.createdAt).toBe(CONFORMANCE_NOW);
    });

    test("the identifier comes from the injected id port, not the adapter", async () => {
      const approvals = await store(harness);

      // The runtime correlates a gate across stores by this id. An adapter
      // that mints its own scheme breaks that correlation silently.
      expect((await approvals.request(CONFORMANCE_APPROVAL)).approvalId).toBe(
        "approval_1",
      );
    });

    test("two gates on one run are two records, not one", async () => {
      const approvals = await store(harness);
      const first = await approvals.request(CONFORMANCE_APPROVAL);
      const second = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        nodeId: "notify",
        effectHash: "sha256:other",
      });

      expect(second.approvalId).not.toBe(first.approvalId);
      expect(await approvals.get(second.approvalId)).toMatchObject({
        nodeId: "notify",
        effectHash: "sha256:other",
      });
    });

    test("reading back a gate that was never opened reports absence", async () => {
      expect(
        await (await store(harness)).get("approval_missing"),
      ).toBeUndefined();
    });
  });
}

function describeSingleUse(harness: ApprovalConformanceHarness): void {
  describe("a decision is single-use", () => {
    test("each decision kind maps to its own terminal status", async () => {
      for (const [decision, expected] of DECISIONS) {
        const approvals = await store(harness);
        const approval = await approvals.request(CONFORMANCE_APPROVAL);
        const decided = await approvals.decide(
          approval.approvalId,
          decision,
          "someone",
        );

        expect(decided?.status).toBe(expected);
        expect(decided?.decidedBy).toBe("someone");
        expect(decided?.decidedAt).toBe(CONFORMANCE_NOW);
      }
    });

    test("a rejected gate cannot later be approved", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      const rejected = await approvals.decide(
        approval.approvalId,
        { kind: "reject", reason: "not ready" },
        "marketing-lead",
      );
      const replayed = await approvals.decide(
        approval.approvalId,
        { kind: "approve" },
        "someone-else",
      );

      expect(rejected?.status).toBe("REJECTED");
      expect(rejected?.reason).toBe("not ready");
      // A repeat delivery must return the decision that stands, not the one
      // it asked for, and must not reattribute it.
      expect(replayed).toEqual(rejected);
    });

    test("every terminal status refuses a second decision", async () => {
      for (const [decision] of DECISIONS) {
        const approvals = await store(harness);
        const approval = await approvals.request(CONFORMANCE_APPROVAL);
        const decided = await approvals.decide(
          approval.approvalId,
          decision,
          "first",
        );

        expect(
          await approvals.decide(
            approval.approvalId,
            { kind: "approve" },
            "second",
          ),
        ).toEqual(decided);
      }
    });

    test("deciding an unknown approval reports absence rather than inventing one", async () => {
      const approvals = await store(harness);

      expect(
        await approvals.decide(
          "approval_missing",
          { kind: "approve" },
          "someone",
        ),
      ).toBeUndefined();
    });

    test("a reason belongs to the rejection that carried it", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      expect(
        (
          await approvals.decide(
            approval.approvalId,
            { kind: "approve" },
            "lead",
          )
        )?.reason,
      ).toBeUndefined();
    });
  });
}

const CONTENDERS = 4;

/**
 * Reads the gate `CONTENDERS` times at once before the race.
 *
 * A backing store that lazily opens connections would otherwise decide the
 * race by connection latency: the one caller whose connection is already open
 * finishes before the rest have finished dialling, and a store with no
 * concurrency control at all would pass. This costs a memory adapter nothing
 * and makes the contention real for everyone else.
 */
async function warm(store: ApprovalPort, approvalId: string): Promise<void> {
  await Promise.all(
    Array.from({ length: CONTENDERS }, () => store.get(approvalId)),
  );
}

function describeRace(harness: ApprovalConformanceHarness): void {
  describe("two processes deciding at once produce one decision", () => {
    test("concurrent decisions all resolve to the single outcome that landed", async () => {
      const handle = await open(harness);
      const approval = await handle.store.request(CONFORMANCE_APPROVAL);
      const peer = await handle.peer();
      await Promise.all([
        warm(handle.store, approval.approvalId),
        warm(peer, approval.approvalId),
      ]);

      // Half the callers approve and half reject, from two independent
      // handles. A check-then-write in application code lets more than one
      // through here; the store has to settle it where the row lives.
      const results = await Promise.all(
        Array.from({ length: CONTENDERS * 2 }, (_, index) =>
          (index % 2 === 0 ? handle.store : peer).decide(
            approval.approvalId,
            index % 2 === 0
              ? { kind: "approve" }
              : { kind: "reject", reason: `contested ${index}` },
            `decider_${index}`,
          ),
        ),
      );

      expect(results.every((record) => record !== undefined)).toBe(true);
      expect(new Set(results.map((record) => record?.status)).size).toBe(1);
      expect(new Set(results.map((record) => record?.decidedBy)).size).toBe(1);
      expect(await peer.get(approval.approvalId)).toEqual(results[0]);
    });

    test("the losing decisions leave no trace on the record", async () => {
      const handle = await open(harness);
      const approval = await handle.store.request(CONFORMANCE_APPROVAL);
      const peer = await handle.peer();
      await Promise.all([
        warm(handle.store, approval.approvalId),
        warm(peer, approval.approvalId),
      ]);

      const results = await Promise.all([
        handle.store.decide(approval.approvalId, { kind: "approve" }, "yes"),
        peer.decide(
          approval.approvalId,
          { kind: "reject", reason: "contested" },
          "no",
        ),
      ]);

      const settled = await peer.get(approval.approvalId);

      expect(results[0]).toEqual(settled);
      expect(results[1]).toEqual(settled);
      // A rejection that lost still wrote its reason onto an approval would be
      // a record nobody could read correctly.
      expect(settled?.reason).toBe(
        settled?.status === "REJECTED" ? "contested" : undefined,
      );
      expect(await peer.getPending(CONFORMANCE_APPROVAL.runId)).toEqual([]);
    });
  });
}

function describeExpiry(harness: ApprovalConformanceHarness): void {
  describe("an expired gate is not a slow yes", () => {
    test("a timeout is terminal, so a late approval cannot revive the gate", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      const expired = await approvals.decide(
        approval.approvalId,
        { kind: "timeout" },
        "scheduler",
      );
      await approvals.decide(
        approval.approvalId,
        { kind: "approve" },
        "marketing-lead",
      );

      expect(expired?.status).toBe("TIMED_OUT");
      expect(await approvals.get(approval.approvalId)).toEqual(expired);
    });

    test("a timed-out gate stops being pending", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      await approvals.decide(
        approval.approvalId,
        { kind: "timeout" },
        "scheduler",
      );

      expect(await approvals.getPending(CONFORMANCE_APPROVAL.runId)).toEqual(
        [],
      );
    });

    test("the expiry the gate was opened with survives verbatim", async () => {
      const handle = await open(harness);
      const approval = await handle.store.request(CONFORMANCE_APPROVAL);

      // Whoever decides the timeout reads this back; a store that reformats it
      // moves the deadline.
      expect(
        (await (await handle.peer()).get(approval.approvalId))?.expiresAt,
      ).toBe(CONFORMANCE_APPROVAL.expiresAt);
    });
  });
}

function describeEdit(harness: ApprovalConformanceHarness): void {
  describe("an edit authorises nothing", () => {
    test("an edit is recorded as EDITED, never as an approval", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      const edited = await approvals.decide(
        approval.approvalId,
        { kind: "edit", patch: { body: "amended" } },
        "marketing-lead",
      );

      expect(edited?.status).toBe("EDITED");
      expect(await approvals.getPending(CONFORMANCE_APPROVAL.runId)).toEqual(
        [],
      );
    });

    test("the amended action needs a gate of its own", async () => {
      const approvals = await store(harness);
      const original = await approvals.request(CONFORMANCE_APPROVAL);
      await approvals.decide(
        original.approvalId,
        { kind: "edit", patch: { body: "amended" } },
        "marketing-lead",
      );

      // The binding covers the artifact, so an amendment is a different
      // action and is reissued rather than inherited.
      const reissued = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        effectHash: "sha256:effect-amended",
      });

      expect(reissued.approvalId).not.toBe(original.approvalId);
      expect(reissued.status).toBe("PENDING");
      expect(await approvals.getPending(CONFORMANCE_APPROVAL.runId)).toEqual([
        reissued,
      ]);
      expect((await approvals.get(original.approvalId))?.status).toBe("EDITED");
    });

    test("approving the reissued gate does not disturb the edited one", async () => {
      const approvals = await store(harness);
      const original = await approvals.request(CONFORMANCE_APPROVAL);
      await approvals.decide(
        original.approvalId,
        { kind: "edit", patch: {} },
        "lead",
      );
      const reissued = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        effectHash: "sha256:effect-amended",
      });

      await approvals.decide(reissued.approvalId, { kind: "approve" }, "lead");

      expect((await approvals.get(original.approvalId))?.status).toBe("EDITED");
      expect((await approvals.get(reissued.approvalId))?.status).toBe(
        "APPROVED",
      );
    });
  });
}

function describePending(harness: ApprovalConformanceHarness): void {
  describe("pending gates are scoped to their run", () => {
    test("another run's gates are not offered for decision", async () => {
      const approvals = await store(harness);
      await approvals.request(CONFORMANCE_APPROVAL);

      expect(
        await approvals.getPending(CONFORMANCE_APPROVAL.runId),
      ).toHaveLength(1);
      expect(await approvals.getPending("run_other")).toEqual([]);
    });

    test("pending gates are listed in the order they were opened", async () => {
      const approvals = await store(harness);
      const first = await approvals.request(CONFORMANCE_APPROVAL);
      const second = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        nodeId: "notify",
        effectHash: "sha256:other",
      });

      expect(await approvals.getPending(CONFORMANCE_APPROVAL.runId)).toEqual([
        first,
        second,
      ]);
    });

    test("deciding one gate leaves the others pending", async () => {
      const approvals = await store(harness);
      const first = await approvals.request(CONFORMANCE_APPROVAL);
      const second = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        nodeId: "notify",
        effectHash: "sha256:other",
      });

      await approvals.decide(first.approvalId, { kind: "approve" }, "lead");

      expect(await approvals.getPending(CONFORMANCE_APPROVAL.runId)).toEqual([
        second,
      ]);
    });
  });
}

function describeRunHistory(harness: ApprovalConformanceHarness): void {
  describe("a run keeps the gates it refused, not only the ones it owes", () => {
    test("a decided gate stays in the run's history, oldest first", async () => {
      const approvals = await store(harness);
      const first = await approvals.request(CONFORMANCE_APPROVAL);
      const second = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        nodeId: "notify",
        effectHash: "sha256:other",
      });
      const rejected = await approvals.decide(
        first.approvalId,
        { kind: "reject", reason: "not ready" },
        "marketing-lead",
      );

      // A refusal that vanished from the record would be the outcome least
      // able to be audited and most worth auditing.
      expect(await approvals.listByRun(CONFORMANCE_APPROVAL.runId)).toEqual([
        rejected,
        second,
      ]);
    });

    test("another run's history is not visible", async () => {
      const approvals = await store(harness);
      await approvals.request(CONFORMANCE_APPROVAL);

      expect(await approvals.listByRun("run_other")).toEqual([]);
    });
  });
}

function describeInbox(harness: ApprovalConformanceHarness): void {
  describe("an inbox shows an operator the gates that name them", () => {
    test("a gate names its approvers, and only they are shown it", async () => {
      const approvals = await store(harness);
      const marketing = await approvals.request(CONFORMANCE_APPROVAL);
      await approvals.request({
        ...CONFORMANCE_APPROVAL,
        runId: "run_2",
        approvers: ["finance-lead"],
      });

      expect(await approvals.listPendingFor("marketing-lead")).toEqual([
        marketing,
      ]);
    });

    test("the inbox crosses runs, because an operator's queue is not one run", async () => {
      const approvals = await store(harness);
      const first = await approvals.request(CONFORMANCE_APPROVAL);
      const second = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        runId: "run_2",
      });

      expect(await approvals.listPendingFor("marketing-lead")).toEqual([
        first,
        second,
      ]);
    });

    test("a gate that names nobody is open to any authenticated operator", async () => {
      const approvals = await store(harness);
      const unassigned = await approvals.request({
        ...CONFORMANCE_APPROVAL,
        approvers: [],
      });

      // Otherwise it would be visible to no one and the run would stall
      // behind a decision nobody could see they had to make.
      expect(await approvals.listPendingFor("anyone")).toEqual([unassigned]);
    });

    test("a decided gate leaves the inbox", async () => {
      const approvals = await store(harness);
      const approval = await approvals.request(CONFORMANCE_APPROVAL);

      await approvals.decide(approval.approvalId, { kind: "approve" }, "lead");

      expect(await approvals.listPendingFor("marketing-lead")).toEqual([]);
    });
  });
}

function describeDurability(harness: ApprovalConformanceHarness): void {
  describe("a gate outlives the handle that opened it", () => {
    test("a pending gate is visible to a second handle onto the same store", async () => {
      const handle = await open(harness);
      const approval = await handle.store.request(CONFORMANCE_APPROVAL);

      const peer = await handle.peer();

      expect(await peer.get(approval.approvalId)).toEqual(approval);
      expect(await peer.getPending(CONFORMANCE_APPROVAL.runId)).toEqual([
        approval,
      ]);
    });

    test("a decision taken on one handle is the decision the other sees", async () => {
      const handle = await open(harness);
      const approval = await handle.store.request(CONFORMANCE_APPROVAL);
      const peer = await handle.peer();

      const rejected = await handle.store.decide(
        approval.approvalId,
        { kind: "reject", reason: "not ready" },
        "marketing-lead",
      );

      expect(await peer.get(approval.approvalId)).toEqual(rejected);
      expect(
        await peer.decide(approval.approvalId, { kind: "approve" }, "someone"),
      ).toEqual(rejected);
    });

    test("the approver list survives the round trip", async () => {
      const handle = await open(harness);
      const approval = await handle.store.request({
        ...CONFORMANCE_APPROVAL,
        approvers: ["marketing-lead", "finance-lead"],
      });

      expect(
        (await (await handle.peer()).get(approval.approvalId))?.approvers,
      ).toEqual(["marketing-lead", "finance-lead"]);
    });
  });
}

function describeIsolation(harness: ApprovalConformanceHarness): void {
  describe("two stores are two stores", () => {
    test("a gate opened in one store is not visible in another", async () => {
      const first = await store(harness);
      const second = await store(harness);
      const approval = await first.request(CONFORMANCE_APPROVAL);

      // Guards the suite itself: every test above assumes it starts empty.
      expect(await second.get(approval.approvalId)).toBeUndefined();
    });
  });
}

/**
 * Runs the whole `ApprovalPort` contract against one adapter. The invariants
 * here are the ones the platform is built on — single use, expiry, and an edit
 * that authorises nothing — so an adapter earns them by passing this rather
 * than by asserting them in its own words.
 */
export function describeApprovalStoreConformance(
  harness: ApprovalConformanceHarness,
): void {
  describe(`${harness.name} · ApprovalPort conformance`, () => {
    describeBinding(harness);
    describeSingleUse(harness);
    describeRace(harness);
    describeExpiry(harness);
    describeEdit(harness);
    describePending(harness);
    describeRunHistory(harness);
    describeInbox(harness);
    describeDurability(harness);
    describeIsolation(harness);
  });
}
