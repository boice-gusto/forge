import type { ForgeJob } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createMemoryQueue } from "./queue.js";

const execute = (attempt: number): ForgeJob => ({
  type: "workflow.execute",
  runId: "run_1",
  workflowVersionId: "wf@1.0.0",
  attempt,
});

describe("memory queue", () => {
  test("delivers a job to the subscriber", async () => {
    const queue = createMemoryQueue();
    const seen: ForgeJob[] = [];
    await queue.subscribe(async (job) => {
      seen.push(job);
    });
    await queue.enqueue(execute(1));

    expect(seen).toHaveLength(1);
    expect(await queue.depth()).toBe(0);
  });

  test("the same operation enqueued twice is handled once", async () => {
    const queue = createMemoryQueue();
    let handled = 0;
    await queue.subscribe(async () => {
      handled += 1;
    });
    await queue.enqueue(execute(1));
    await queue.enqueue(execute(1));

    expect(handled).toBe(1);
  });

  test("a different attempt is a different operation", async () => {
    const queue = createMemoryQueue();
    let handled = 0;
    await queue.subscribe(async () => {
      handled += 1;
    });
    await queue.enqueue(execute(1));
    await queue.enqueue(execute(2));

    expect(handled).toBe(2);
  });

  test("resume is keyed by approval, so one decision resumes once", async () => {
    const queue = createMemoryQueue();
    const seen: ForgeJob[] = [];
    await queue.subscribe(async (job) => {
      seen.push(job);
    });
    const resume: ForgeJob = {
      type: "workflow.resume",
      runId: "run_1",
      approvalId: "approval_1",
      attempt: 2,
    };
    await queue.enqueue(resume);
    await queue.enqueue({ ...resume, attempt: 9 });

    expect(seen).toHaveLength(1);
  });

  test("work enqueued before a subscriber arrives is not lost", async () => {
    const queue = createMemoryQueue();
    await queue.enqueue(execute(1));
    expect(await queue.depth()).toBe(1);

    const seen: ForgeJob[] = [];
    await queue.subscribe(async (job) => {
      seen.push(job);
    });

    expect(seen).toHaveLength(1);
  });
});
