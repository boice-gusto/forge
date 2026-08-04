import { createMemoryApprovalStore } from "@forge/approval-memory";
import { createMemoryCheckpointStore } from "@forge/checkpoint-memory";
import { compileWorkflow } from "@forge/compiler";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import { createMemoryObservability } from "@forge/observability-memory";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import { createSequentialIds } from "@forge/ports";
import { createMockProvider } from "@forge/provider-mock";
import { describe, expect, test } from "vitest";

import { createRuntime, effectHash, type SealedArtifact } from "./runtime.js";

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
  let instant = new Date("2026-08-04T00:00:00.000Z");
  const clock = { now: () => new Date(instant) };
  const advance = (ms: number) => {
    instant = new Date(instant.getTime() + ms);
  };
  const ids = createSequentialIds();
  const approvals = createMemoryApprovalStore(clock, ids);
  const checkpoints = createMemoryCheckpointStore();
  const observability = createMemoryObservability();

  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({ rules, grants, failEvaluation }),
    approvals,
    provider: createMockProvider({
      providerId: "mock",
      events: [{ type: "completed" }],
    }),
    sandbox: { health: async () => ({ available: true }) },
    observability,
    panel: { standing: [], summonable: [], quorum: 0.5 },
    effects: {
      async perform(_runId, _nodeId, effect) {
        dispatched.push(effect);
      },
    },
    checkpoints,
    clock,
    ids,
    actor: "svc.forge.worker",
    environment: "production",
    approvalTtlMs: 7 * 24 * 60 * 60 * 1000,
  });
  return {
    runtime,
    dispatched,
    checkpoints,
    approvals,
    advance,
    observability,
  };
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
    const approval = await runtime.getApproval(run.pendingApprovalId as string);

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
    expect((await runtime.getApproval(approvalId))?.status).toBe("REJECTED");
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

describe("durability and binding", () => {
  test("parking the run writes a checkpoint for the gated node", async () => {
    const { runtime, checkpoints } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    const saved = await checkpoints.listByRun(run.runId);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.stepId).toBe("publish");
    expect(saved[0]?.resumeToken).toBe(
      (await runtime.getApproval(run.pendingApprovalId as string))?.effectHash,
    );
  });

  test("the binding covers the artifact fingerprint, not just the action", () => {
    const base = {
      runId: "run_1",
      nodeId: "publish",
      effect: "slack.post",
      fingerprint: "sha256:aaa",
    };

    expect(effectHash(base)).toBe(effectHash({ ...base }));
    expect(effectHash(base)).not.toBe(
      effectHash({ ...base, fingerprint: "sha256:bbb" }),
    );
    expect(effectHash(base)).not.toBe(effectHash({ ...base, nodeId: "other" }));
    expect(effectHash(base)).not.toBe(effectHash({ ...base, runId: "run_2" }));
  });

  test("a stale binding is refused rather than honoured", async () => {
    const { runtime, dispatched } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const approval = await runtime.getApproval(run.pendingApprovalId as string);

    // Simulate an approval that survived a recompile: the stored binding no
    // longer agrees with the action under the current fingerprint.
    (approval as unknown as { effectHash: string }).effectHash = "sha256:stale";

    await expect(
      runtime.decide(
        run.pendingApprovalId as string,
        { kind: "approve" },
        "marketing-lead",
      ),
    ).rejects.toThrow("no longer matches");
    expect(dispatched).toEqual([]);
  });
});

const guarded = {
  id: "acme.guarded",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.guarded.input@1" },
    { id: "assert", kind: "policy_check", capability: "slack.write" },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "acme.guarded.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "slack.post@1",
      effect: "slack.post",
    },
    { id: "result", kind: "output", schemaRef: "acme.guarded.output@1" },
  ],
  edges: [
    { from: "intake", to: "assert" },
    { from: "assert", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

function guardedArtifact(): SealedArtifact {
  const compiled = compileWorkflow(guarded);
  if (!compiled.ok) throw new Error("Fixture must compile.");
  return {
    workflowId: compiled.value.ir.workflowId,
    fingerprint: compiled.value.fingerprint,
    ir: compiled.value.ir,
  };
}

describe("policy_check is enforced at runtime", () => {
  test("a granted capability lets the walk continue to the gate", async () => {
    const { runtime, dispatched } = harness();
    const run = await runtime.start({
      artifact: guardedArtifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(dispatched).toEqual([]);
  });

  test("an ungranted capability fails the run at that node, before any gate", async () => {
    const { runtime, dispatched } = harness(REQUIRE_APPROVAL, [
      "something.else",
    ]);
    const run = await runtime.start({
      artifact: guardedArtifact(),
      capabilities: [],
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("assert");
    expect(run.error).toContain("slack.write");
    expect(run.pendingApprovalId).toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  test("a failed assertion is not retryable and leaves no checkpoint", async () => {
    const { runtime, checkpoints } = harness(REQUIRE_APPROVAL, [
      "something.else",
    ]);
    const run = await runtime.start({
      artifact: guardedArtifact(),
      capabilities: [],
    });

    expect(await checkpoints.listByRun(run.runId)).toEqual([]);
  });
});

describe("expiry and amendment", () => {
  test("an approval carries an expiry derived from the configured TTL", async () => {
    const { runtime } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const approval = await runtime.getApproval(run.pendingApprovalId as string);

    expect(approval?.expiresAt).toBe("2026-08-11T00:00:00.000Z");
  });

  test("an expired gate is not a slow yes", async () => {
    const { runtime, dispatched, advance } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    advance(8 * 24 * 60 * 60 * 1000);
    const after = await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(after.status).toBe("FAILED");
    expect(after.error).toContain("expired");
    expect(dispatched).toEqual([]);
    expect(
      (await runtime.getApproval(run.pendingApprovalId as string))?.status,
    ).toBe("TIMED_OUT");
  });

  test("deciding just inside the window still works", async () => {
    const { runtime, dispatched, advance } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    advance(6 * 24 * 60 * 60 * 1000);
    const after = await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(after.status).toBe("SUCCEEDED");
    expect(dispatched).toEqual(["slack.post"]);
  });

  test("an explicit timeout decision fails the run without dispatching", async () => {
    const { runtime, dispatched } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const after = await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "timeout" },
      "sweeper",
    );

    expect(after.status).toBe("FAILED");
    expect(after.error).toContain("timed out");
    expect(dispatched).toEqual([]);
  });

  test("an edit authorises nothing and reissues the gate", async () => {
    const { runtime, dispatched } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const first = run.pendingApprovalId as string;

    const after = await runtime.decide(
      first,
      { kind: "edit", patch: { copy: "reworded" } },
      "marketing-lead",
    );

    expect(after.status).toBe("AWAITING_APPROVAL");
    expect(after.pendingApprovalId).not.toBe(first);
    expect(dispatched).toEqual([]);
    expect((await runtime.getApproval(first))?.status).toBe("EDITED");
  });

  test("the reissued gate can then be approved, dispatching once", async () => {
    const { runtime, dispatched } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const edited = await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "edit", patch: {} },
      "marketing-lead",
    );
    const done = await runtime.decide(
      edited.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(done.status).toBe("SUCCEEDED");
    expect(dispatched).toEqual(["slack.post"]);
  });

  test("getPending reflects only the live gate", async () => {
    const { runtime, approvals } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(await approvals.getPending(run.runId)).toHaveLength(1);
    await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );
    expect(await approvals.getPending(run.runId)).toEqual([]);
  });
});

const reviewed = {
  id: "acme.reviewed",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  roles: {
    writer: {
      version: "1.0.0",
      capabilities: { requires: [], forbids: [] },
      review: { weight: 1, blocking: false },
    },
    security: {
      version: "1.0.0",
      capabilities: { requires: [], forbids: [] },
      review: { weight: 2, blocking: true },
      summon: { anyPathMatches: ["**/credentials/**"] },
    },
  },
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    { id: "isolate", kind: "sandbox", profile: "docker" },
    { id: "draft", kind: "agent", promptRef: "p@1", retry: { maxAttempts: 3 } },
    { id: "panel", kind: "judge", judgeRef: "j@1" },
    { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["publish"] },
    { id: "publish", kind: "tool", skillRef: "t@1", effect: "slack.post" },
    { id: "result", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "intake", to: "isolate" },
    { from: "isolate", to: "draft" },
    { from: "draft", to: "panel" },
    { from: "panel", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

function reviewedArtifact(): SealedArtifact {
  const compiled = compileWorkflow(reviewed);
  if (!compiled.ok) throw new Error("Fixture must compile.");
  return {
    workflowId: compiled.value.ir.workflowId,
    fingerprint: compiled.value.fingerprint,
    ir: compiled.value.ir,
  };
}

function reviewHarness(opts: {
  votes?: Record<string, "pass" | "fail" | "error">;
  paths?: string[];
  sandboxAvailable?: boolean;
  providerFails?: boolean;
}) {
  const dispatched: string[] = [];
  const observability = createMemoryObservability();
  const ids = createSequentialIds();
  const clock = { now: () => new Date("2026-08-04T00:00:00.000Z") };

  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({ rules: REQUIRE_APPROVAL, grants: [] }),
    approvals: createMemoryApprovalStore(clock, ids),
    provider: createMockProvider({
      providerId: "mock",
      events: opts.providerFails
        ? [
            {
              type: "error",
              code: "PROVIDER_TIMEOUT",
              message: "timed out",
              retryable: true,
            },
          ]
        : [{ type: "completed" }],
    }),
    sandbox: {
      health: async () => ({ available: opts.sandboxAvailable ?? true }),
    },
    observability,
    panel: { standing: ["writer"], summonable: ["security"], quorum: 0.5 },
    votesFor: () => opts.votes ?? {},
    effects: {
      async perform(_r, _n, effect) {
        dispatched.push(effect);
      },
    },
    checkpoints: createMemoryCheckpointStore(),
    clock,
    ids,
    actor: "svc.forge.worker",
    environment: "production",
    approvalTtlMs: 1000,
  });
  return { runtime, dispatched, observability };
}

describe("agent, judge and sandbox nodes are live", () => {
  test("a clean panel lets the run reach its gate", async () => {
    const { runtime, dispatched } = reviewHarness({
      votes: { writer: "pass" },
    });
    const run = await runtime.start({
      artifact: reviewedArtifact(),
      changedPaths: ["docs/x.md"],
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(dispatched).toEqual([]);
  });

  test("a summoned blocking role can veto the whole run", async () => {
    const { runtime, dispatched } = reviewHarness({
      votes: { writer: "pass", security: "fail" },
      paths: ["app/credentials/key.xml"],
    });
    const run = await runtime.start({
      artifact: reviewedArtifact(),
      changedPaths: ["app/credentials/key.xml"],
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("judge verdict fail");
    expect(dispatched).toEqual([]);
  });

  test("no votes fails closed to review, never past the judge", async () => {
    const { runtime } = reviewHarness({ votes: {} });
    const run = await runtime.start({ artifact: reviewedArtifact() });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("judge verdict review");
  });

  test("an unavailable sandbox stops the walk with no host fallback", async () => {
    const { runtime, dispatched } = reviewHarness({
      votes: { writer: "pass" },
      sandboxAvailable: false,
    });
    const run = await runtime.start({ artifact: reviewedArtifact() });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("host execution is not permitted");
    expect(dispatched).toEqual([]);
  });

  test("a provider error retries up to the declared budget, then fails", async () => {
    const { runtime, observability } = reviewHarness({
      votes: { writer: "pass" },
      providerFails: true,
    });
    const run = await runtime.start({ artifact: reviewedArtifact() });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("PROVIDER_TIMEOUT");
    // maxAttempts 3 on the agent node: two retries then give up.
    expect(run.attempt).toBe(3);
    expect(
      observability.events.filter((e) => e.name === "forge.run.retry"),
    ).toHaveLength(2);
  });

  test("the run reports spans for itself and for each intelligent node", async () => {
    const { runtime, observability } = reviewHarness({
      votes: { writer: "pass" },
    });
    await runtime.start({ artifact: reviewedArtifact() });

    expect(observability.names()).toContain("forge.run.start");
    expect(observability.names()).toContain("forge.node.agent");
    expect(observability.names()).toContain("forge.node.judge");
    expect(observability.events.map((e) => e.name)).toContain(
      "forge.node.sandbox",
    );
    expect(observability.spans.every((span) => span.ended)).toBe(true);
  });
});
