import { createMemoryCheckpointStore } from "@forge/checkpoint-memory";
import { compileWorkflow } from "@forge/compiler";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import { createFixedClock, createSequentialIds } from "@forge/ports";
import { describe, expect, test } from "vitest";

import {
  createRuntime,
  type EffectSink,
  type SealedArtifact,
} from "./runtime.js";

const source = {
  id: "acme.publish",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.publish.input@1" },
    { id: "draft", kind: "agent", promptRef: "acme.publish.draft@1" },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "acme.publish.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "slack.post@1",
      effect: "slack.post",
    },
    { id: "result", kind: "output", schemaRef: "acme.publish.output@1" },
  ],
  edges: [
    { from: "intake", to: "draft" },
    { from: "draft", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

function artifact(): SealedArtifact {
  const compiled = compileWorkflow(source);
  if (!compiled.ok) throw new Error("Fixture must compile.");
  return {
    workflowId: compiled.value.ir.workflowId,
    fingerprint: compiled.value.fingerprint,
    ir: compiled.value.ir,
  };
}

const REQUIRE_APPROVAL: readonly PolicyRule[] = [
  {
    id: "acme.publish.external",
    action: "slack.post",
    environment: "production",
    decision: "require-approval",
    reason: "External publication is a human call.",
    approvers: ["marketing-lead"],
  },
];

function harness(
  rules: readonly PolicyRule[] = REQUIRE_APPROVAL,
  grants: readonly string[] = ["slack.write"],
  failEvaluation = false,
) {
  const dispatched: string[] = [];
  const effects: EffectSink = {
    async perform(_runId, _nodeId, effect) {
      dispatched.push(effect);
    },
  };
  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({ rules, grants, failEvaluation }),
    effects,
    checkpoints: createMemoryCheckpointStore(),
    clock: createFixedClock("2026-08-04T00:00:00.000Z"),
    ids: createSequentialIds(),
    actor: "svc.forge.worker",
    environment: "production",
  });
  return { runtime, dispatched };
}

describe("run lifecycle", () => {
  test("a side effect parks the run at AWAITING_APPROVAL and dispatches nothing", async () => {
    const { runtime, dispatched } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.pendingApprovalId).toBeDefined();
    expect(dispatched).toEqual([]);
  });

  test("the approval binds to the exact effect and names the policy that required it", async () => {
    const { runtime } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const approval = runtime.getApproval(run.pendingApprovalId as string);

    expect(approval?.nodeId).toBe("publish");
    expect(approval?.effect).toBe("slack.post");
    expect(approval?.policyId).toBe("acme.publish.external");
    expect(approval?.approvers).toEqual(["marketing-lead"]);
    expect(approval?.effectHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("approving dispatches the effect exactly once and succeeds", async () => {
    const { runtime, dispatched } = harness();
    const started = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const resumed = await runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(resumed.status).toBe("SUCCEEDED");
    expect(dispatched).toEqual(["slack.post"]);
    expect(runtime.ledger(resumed.runId)).toEqual(["publish"]);
    expect(resumed.attempt).toBe(2);
  });

  test("rejecting leaves zero effects dispatched", async () => {
    const { runtime, dispatched } = harness();
    const started = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const rejected = await runtime.decide(
      started.pendingApprovalId as string,
      { kind: "reject", reason: "Copy is not ready." },
      "marketing-lead",
    );

    expect(rejected.status).toBe("FAILED");
    expect(rejected.error).toContain("Copy is not ready.");
    expect(dispatched).toEqual([]);
  });

  test("deciding the same approval twice does not dispatch twice", async () => {
    const { runtime, dispatched } = harness();
    const started = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const approvalId = started.pendingApprovalId as string;

    await runtime.decide(approvalId, { kind: "approve" }, "marketing-lead");
    await runtime.decide(approvalId, { kind: "approve" }, "marketing-lead");

    expect(dispatched).toEqual(["slack.post"]);
  });

  test("an approval cannot be replayed to reverse an earlier decision", async () => {
    const { runtime, dispatched } = harness();
    const started = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const approvalId = started.pendingApprovalId as string;

    await runtime.decide(
      approvalId,
      { kind: "reject", reason: "no" },
      "marketing-lead",
    );
    const after = await runtime.decide(
      approvalId,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(after.status).toBe("FAILED");
    expect(dispatched).toEqual([]);
    expect(runtime.getApproval(approvalId)?.status).toBe("REJECTED");
  });
});

describe("policy is decided before a human is asked", () => {
  test("a denied action never reaches an approver", async () => {
    const { runtime, dispatched } = harness([
      {
        id: "acme.publish.blocked",
        action: "slack.post",
        decision: "deny",
        reason: "External publication is disabled.",
      },
    ]);
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("FAILED");
    expect(run.pendingApprovalId).toBeUndefined();
    expect(run.error).toContain("acme.publish.blocked");
    expect(dispatched).toEqual([]);
  });

  test("a capability outside the granted closure is denied, whatever the rules say", async () => {
    const { runtime, dispatched } = harness(
      [
        {
          id: "acme.publish.open",
          action: "slack.post",
          decision: "allow",
          reason: "Allowed.",
        },
      ],
      ["slack.write"],
    );
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write", "repo.merge"],
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("capability-closure");
    expect(run.error).toContain("repo.merge");
    expect(dispatched).toEqual([]);
  });

  test("an evaluator error fails closed rather than open", async () => {
    const { runtime, dispatched } = harness(
      REQUIRE_APPROVAL,
      ["slack.write"],
      true,
    );
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("evaluator-error");
    expect(dispatched).toEqual([]);
  });

  test("an unmatched action denies by default", async () => {
    const { runtime, dispatched } = harness([]);
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("default-deny");
    expect(dispatched).toEqual([]);
  });

  test("an allowed action runs straight through without an approval", async () => {
    const { runtime, dispatched } = harness([
      {
        id: "acme.publish.trusted",
        action: "slack.post",
        decision: "allow",
        reason: "Low risk.",
      },
    ]);
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("SUCCEEDED");
    expect(dispatched).toEqual(["slack.post"]);
  });
});

describe("cancellation", () => {
  test("cancelling a waiting run clears the gate and dispatches nothing", async () => {
    const { runtime, dispatched } = harness();
    const started = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const cancelled = await runtime.cancel(started.runId);

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.pendingApprovalId).toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  test("an approval arriving after cancellation is refused", async () => {
    const { runtime, dispatched } = harness();
    const started = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    await runtime.cancel(started.runId);

    await expect(
      runtime.decide(
        started.pendingApprovalId as string,
        { kind: "approve" },
        "marketing-lead",
      ),
    ).rejects.toThrow("cancelled");
    expect(dispatched).toEqual([]);
  });

  test("cancelling a finished run leaves it finished", async () => {
    const { runtime } = harness([
      {
        id: "acme.publish.trusted",
        action: "slack.post",
        decision: "allow",
        reason: "Low risk.",
      },
    ]);
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    expect((await runtime.cancel(run.runId)).status).toBe("SUCCEEDED");
  });
});

describe("run records", () => {
  test("a run carries the fingerprint of the artifact it executed", async () => {
    const { runtime } = harness();
    const sealed = artifact();
    const run = await runtime.start({
      artifact: sealed,
      capabilities: ["slack.write"],
    });

    expect(run.fingerprint).toBe(sealed.fingerprint);
    expect(run.workflowId).toBe("acme.publish");
    expect(runtime.getRun(run.runId)).toEqual(run);
  });

  test("two runs of the same artifact are independent", async () => {
    const { runtime } = harness();
    const sealed = artifact();
    const first = await runtime.start({
      artifact: sealed,
      capabilities: ["slack.write"],
    });
    const second = await runtime.start({
      artifact: sealed,
      capabilities: ["slack.write"],
    });

    expect(first.runId).not.toBe(second.runId);
    await runtime.decide(
      first.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );
    expect(runtime.getRun(second.runId)?.status).toBe("AWAITING_APPROVAL");
  });
});
