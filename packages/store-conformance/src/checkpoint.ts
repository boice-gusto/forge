import { describe, expect, test } from "vitest";

import {
  type CheckpointConformanceHarness,
  CONFORMANCE_CHECKPOINT,
} from "./harness.js";

function describeIdentity(harness: CheckpointConformanceHarness): void {
  describe("a checkpoint is retrievable by the id it was issued", () => {
    test("save returns the record it stored, under an id load accepts", async () => {
      const { store } = await harness.create();
      const checkpoint = await store.save(CONFORMANCE_CHECKPOINT);

      expect(checkpoint).toMatchObject(CONFORMANCE_CHECKPOINT);
      expect(checkpoint.checkpointId).not.toBe("");
      expect(await store.load(checkpoint.checkpointId)).toEqual(checkpoint);
    });

    test("an unknown id reports absence rather than inventing a resume point", async () => {
      const { store } = await harness.create();

      // A fabricated checkpoint would resume a run from a state nobody wrote.
      expect(await store.load("checkpoint_never_written")).toBeUndefined();
    });

    test("two saves of the same step are two checkpoints, not one", async () => {
      const { store } = await harness.create();
      const first = await store.save(CONFORMANCE_CHECKPOINT);
      const second = await store.save(CONFORMANCE_CHECKPOINT);

      expect(second.checkpointId).not.toBe(first.checkpointId);
      expect(await store.listByRun(CONFORMANCE_CHECKPOINT.runId)).toHaveLength(
        2,
      );
    });
  });
}

function describeListing(harness: CheckpointConformanceHarness): void {
  describe("checkpoints are listed per run, oldest first", () => {
    test("a run sees its own checkpoints in the order they were written", async () => {
      const { store } = await harness.create();
      const first = await store.save(CONFORMANCE_CHECKPOINT);
      const second = await store.save({
        ...CONFORMANCE_CHECKPOINT,
        stepId: "publish",
        stateVersion: 2,
        resumeToken: "resume_456",
      });

      expect(await store.listByRun(CONFORMANCE_CHECKPOINT.runId)).toEqual([
        first,
        second,
      ]);
    });

    test("another run's checkpoints are not visible", async () => {
      const { store } = await harness.create();
      await store.save(CONFORMANCE_CHECKPOINT);

      expect(await store.listByRun("run_other")).toEqual([]);
    });

    test("a run with no checkpoints lists nothing", async () => {
      const { store } = await harness.create();

      expect(await store.listByRun("run_never_started")).toEqual([]);
    });
  });
}

function describeDurability(harness: CheckpointConformanceHarness): void {
  describe("a checkpoint outlives the handle that wrote it", () => {
    test("a second handle onto the same store sees the checkpoint", async () => {
      const handle = await harness.create();
      const checkpoint = await handle.store.save(CONFORMANCE_CHECKPOINT);

      const peer = await handle.peer();

      expect(await peer.load(checkpoint.checkpointId)).toEqual(checkpoint);
      expect(await peer.listByRun(CONFORMANCE_CHECKPOINT.runId)).toEqual([
        checkpoint,
      ]);
    });

    test("the values the run had produced survive the round trip", async () => {
      // The reason this field exists: a gate can stay open for days, and a
      // resume that recomputed instead of restoring would dispatch an action
      // nobody approved. A store that drops it breaks that silently, which is
      // exactly how it went unnoticed until a durable adapter was written.
      const handle = await harness.create();
      const values = {
        intake: { member: "synthetic-001", amount: 4200 },
        draft: "copy the reviewer saw",
        route: "clean",
      };

      const written = await handle.store.save({
        ...CONFORMANCE_CHECKPOINT,
        values,
      });

      expect(written.values).toEqual(values);
      const peer = await handle.peer();
      expect((await peer.load(written.checkpointId))?.values).toEqual(values);
    });

    test("a checkpoint with no values reads back with none, not with empty", async () => {
      // Absent and "produced nothing" are different: an input node with no
      // payload produces nothing, and inventing `{}` would let a read of it
      // succeed against a value that was never there.
      const handle = await harness.create();
      const written = await handle.store.save(CONFORMANCE_CHECKPOINT);

      const peer = await handle.peer();
      const read = await peer.load(written.checkpointId);
      expect(read?.values).toBeUndefined();
    });

    test("the state version and resume token survive the round trip verbatim", async () => {
      const handle = await harness.create();
      const written = await handle.store.save({
        ...CONFORMANCE_CHECKPOINT,
        stateVersion: 47,
        // The token binds a resume to one exact action, so a store that
        // mangles it silently authorises a different one. Kept short on
        // purpose: `security:secrets` reads any long quoted value next to the
        // word "token" as a leak, and it is right to.
        resumeToken: "r:9f0c/+=",
      });

      const peer = await handle.peer();
      const loaded = await peer.load(written.checkpointId);

      expect(loaded?.stateVersion).toBe(47);
      expect(loaded?.resumeToken).toBe("r:9f0c/+=");
    });
  });
}

function describeIsolation(harness: CheckpointConformanceHarness): void {
  describe("two stores are two stores", () => {
    test("a checkpoint written to one store is not visible in another", async () => {
      const first = await harness.create();
      const second = await harness.create();
      const checkpoint = await first.store.save(CONFORMANCE_CHECKPOINT);

      // Guards the suite itself: every test above assumes it starts empty.
      expect(await second.store.load(checkpoint.checkpointId)).toBeUndefined();
    });
  });
}

/**
 * Runs the whole `CheckpointStorePort` contract against one adapter. A new
 * checkpoint store proves itself by calling this with its own factory rather
 * than by hand-copying the memory adapter's tests and drifting from them.
 */
export function describeCheckpointStoreConformance(
  harness: CheckpointConformanceHarness,
): void {
  describe(`${harness.name} · CheckpointStorePort conformance`, () => {
    describeIdentity(harness);
    describeListing(harness);
    describeDurability(harness);
    describeIsolation(harness);
  });
}
