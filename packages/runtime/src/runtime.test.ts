import { createMemoryApprovalStore } from "@forge/approval-memory";
import { createMemoryCheckpointStore } from "@forge/checkpoint-memory";
import { compileWorkflow } from "@forge/compiler";
import { createMemoryGraphEngine } from "@forge/engine-memory";
import { createMemoryObservability } from "@forge/observability-memory";
import type { PanelDefinition, Vote } from "@forge/panel";
import { createMemoryPolicy, type PolicyRule } from "@forge/policy-memory";
import {
  createSequentialIds,
  type JsonValue,
  type ObservabilityPort,
  type ProviderPort,
  type SpanAttributes,
} from "@forge/ports";
import { createMockProvider } from "@forge/provider-mock";
import { createMemorySandbox } from "@forge/sandbox";
import { describe, expect, test } from "vitest";

import {
  createRuntime,
  effectHash,
  type SealedArtifact,
  type TransformFn,
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
  /** Supplied only to prove a broken sink cannot decide a run's fate. */
  sink?: ObservabilityPort,
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
    sandbox: createMemorySandbox({ profiles: ["docker"], available: true }),
    observability: sink ?? observability,
    panel: { standing: [], summonable: [], quorum: 0.5 },
    effects: {
      async perform(_runId, _nodeId, effect) {
        dispatched.push(effect);
        return undefined;
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

  const mock = createMockProvider({
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
  });
  /** Where each agent session was told to work; the sandbox is visible here. */
  const workspaces: string[] = [];
  const provider: ProviderPort = {
    ...mock,
    createSession: async (input) => {
      workspaces.push(input.workspacePath);
      return mock.createSession(input);
    },
  };
  const sandbox = createMemorySandbox({
    profiles: ["docker"],
    available: opts.sandboxAvailable ?? true,
  });

  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({ rules: REQUIRE_APPROVAL, grants: [] }),
    approvals: createMemoryApprovalStore(clock, ids),
    provider,
    sandbox,
    observability,
    panel: { standing: ["writer"], summonable: ["security"], quorum: 0.5 },
    votesFor: () => opts.votes ?? {},
    effects: {
      async perform(_r, _n, effect) {
        dispatched.push(effect);
        return undefined;
      },
    },
    checkpoints: createMemoryCheckpointStore(),
    clock,
    ids,
    actor: "svc.forge.worker",
    environment: "production",
    approvalTtlMs: 1000,
  });
  return { runtime, dispatched, observability, sandbox, workspaces };
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

/**
 * 011 §4 makes the decisions telemetry, not a side note: a gate nobody can see
 * open, close, or expire is a gate nobody can audit.
 */
describe("the decisions a run makes are reported, not only its nodes", () => {
  function attributesOf(
    observability: ReturnType<typeof createMemoryObservability>,
    name: string,
  ): SpanAttributes {
    const entry = observability.timeline.find((item) => item.name === name);
    if (entry === undefined) throw new Error(`No ${name} was reported.`);
    return entry.attributes;
  }

  test("the policy decision names the rule that decided and what it decided", async () => {
    const { runtime, observability } = harness();
    await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(attributesOf(observability, "forge.policy.decide")).toMatchObject({
      action: "slack.post",
      nodeId: "publish",
      decision: "require-approval",
      policyId: "acme.publish.external",
      allow: false,
    });
  });

  test("a denial is reported with the rule that denied it", async () => {
    const { runtime, observability } = harness([], []);
    await runtime.start({ artifact: artifact() });

    expect(attributesOf(observability, "forge.policy.decide")).toMatchObject({
      decision: "deny",
      policyId: "forge.policy.default-deny",
      allow: false,
    });
  });

  test("an allow carries no rule id rather than an invented one", async () => {
    const { runtime, observability } = harness(
      [
        {
          id: "acme.publish.open",
          action: "slack.post",
          environment: "production",
          decision: "allow",
          reason: "Internal channel.",
        },
      ],
      ["slack.write"],
    );
    await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    const attributes = attributesOf(observability, "forge.policy.decide");
    expect(attributes).toMatchObject({ decision: "allow", allow: true });
    expect(attributes).not.toHaveProperty("policyId");
  });

  test("the requested gate reports the binding, not just the artifact", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const approval = await runtime.getApproval(run.pendingApprovalId as string);

    expect(
      attributesOf(observability, "forge.approval.requested"),
    ).toMatchObject({
      approvalId: approval?.approvalId,
      nodeId: "publish",
      effect: "slack.post",
      effectHash: approval?.effectHash,
      approverCount: 1,
    });
  });

  test("a decision is reported without naming the human who made it", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "ada@example.test",
    );

    const attributes = attributesOf(observability, "forge.approval.decided");
    expect(attributes).toMatchObject({ decision: "approve" });
    expect(JSON.stringify(attributes)).not.toContain("ada@example.test");
    expect(attributes.principalHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("an expired gate reports the timeout and what was attempted on it", async () => {
    const { runtime, advance, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    advance(8 * 24 * 60 * 60 * 1000);
    await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(attributesOf(observability, "forge.approval.expired")).toMatchObject(
      { nodeId: "publish", attempted: "approve" },
    );
    expect(observability.timeline.map((entry) => entry.name)).not.toContain(
      "forge.effect.dispatched",
    );
  });

  test("an edit names the gate it reissued, so the successor is traceable", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const edited = await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "edit", patch: {} },
      "marketing-lead",
    );

    expect(attributesOf(observability, "forge.approval.edited")).toMatchObject({
      approvalId: run.pendingApprovalId,
      reissuedAs: edited.pendingApprovalId,
    });
  });

  test("every lifecycle transition is reported once, in order", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(
      observability.timeline
        .filter((entry) => entry.name === "forge.run.transition")
        .map((entry) => `${entry.attributes.from}->${entry.attributes.to}`),
    ).toEqual([
      "PENDING->RUNNING",
      "RUNNING->AWAITING_APPROVAL",
      "AWAITING_APPROVAL->RUNNING",
      "RUNNING->SUCCEEDED",
    ]);
  });

  test("a dispatched effect is on the stream, and a replayed one is not", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(
      observability.timeline.filter(
        (entry) => entry.name === "forge.effect.dispatched",
      ),
    ).toHaveLength(1);
    expect(
      attributesOf(observability, "forge.effect.dispatched"),
    ).toMatchObject({ nodeId: "publish", effect: "slack.post", sequence: 1 });
  });

  test("cancelling reports the transition to CANCELLED", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    await runtime.cancel(run.runId);

    expect(
      observability.timeline
        .filter((entry) => entry.name === "forge.run.transition")
        .map((entry) => entry.attributes.to),
    ).toContain("CANCELLED");
  });
});

/**
 * A span is a report. Nothing a payroll system would call member data may ride
 * on one, and no telemetry failure may decide the fate of a run.
 */
describe("telemetry can neither leak a payload nor break a run", () => {
  test("no span attribute carries an email, an SSN or prompt content", async () => {
    const { runtime, observability } = harness();
    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "reject", reason: "ada@example.test says 123-45-6789 is wrong" },
      "ada@example.test",
    );

    const serialised = JSON.stringify(
      observability.timeline.map((entry) => entry.attributes),
    );
    expect(serialised).not.toContain("ada@example.test");
    expect(serialised).not.toContain("123-45-6789");
    // Attributes are scalars keyed by name: no free-text payload can arrive
    // under a key the taxonomy never declared.
    for (const entry of observability.timeline) {
      for (const value of Object.values(entry.attributes)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
  });

  test("a sink that throws does not fail a run that otherwise succeeds", async () => {
    const broken: ObservabilityPort = {
      startSpan() {
        throw new Error("collector unreachable");
      },
      event() {
        throw new Error("collector unreachable");
      },
    };
    const { runtime, dispatched } = harness(
      REQUIRE_APPROVAL,
      ["slack.write"],
      false,
      broken,
    );

    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });
    const decided = await runtime.decide(
      run.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(decided.status).toBe("SUCCEEDED");
    expect(dispatched).toEqual(["slack.post"]);
  });

  test("a span that throws only on end is still harmless", async () => {
    const brokenOnEnd: ObservabilityPort = {
      startSpan: () => ({
        end() {
          throw new Error("collector went away mid-span");
        },
      }),
      event: () => undefined,
    };
    const { runtime } = harness(
      REQUIRE_APPROVAL,
      ["slack.write"],
      false,
      brokenOnEnd,
    );

    const run = await runtime.start({
      artifact: artifact(),
      capabilities: ["slack.write"],
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
  });
});

/**
 * The run data plane.
 *
 * Values flow along declared reads, and every one of them is pinned per run for
 * the same reason effects and verdicts are: a resumed attempt re-walks the
 * nodes before the interrupt, and an agent or a transform asked twice may
 * answer twice. The action a human approved has to be the action performed,
 * which means the data it was computed from cannot move underneath it.
 */

const dataFlow = {
  id: "acme.data",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  nodes: [
    { id: "intake", kind: "input", schemaRef: "s@1" },
    {
      id: "shape",
      kind: "transform",
      transformRef: "shape@1",
      reads: { node: "intake" },
    },
    { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["publish"] },
    {
      id: "publish",
      kind: "tool",
      skillRef: "t@1",
      effect: "slack.post",
      reads: { node: "shape" },
    },
    {
      id: "result",
      kind: "output",
      schemaRef: "s@1",
      reads: { node: "publish" },
    },
  ],
  edges: [
    { from: "intake", to: "shape" },
    { from: "shape", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

function sealed(source: unknown): SealedArtifact {
  const compiled = compileWorkflow(source);
  if (!compiled.ok)
    throw new Error(
      `Fixture must compile: ${compiled.diagnostics.map((d) => d.message).join("; ")}`,
    );
  return {
    workflowId: compiled.value.ir.workflowId,
    fingerprint: compiled.value.fingerprint,
    ir: compiled.value.ir,
  };
}

/** A provider whose reply differs every call, as a flaky model would. */
function driftingProvider(replies: readonly string[]): {
  readonly port: ProviderPort;
  readonly calls: () => number;
} {
  let call = 0;
  const port: ProviderPort = {
    providerId: "drift",
    capabilities: ["streaming"],
    createSession: async () => ({ sessionId: "s_1", providerId: "drift" }),
    resumeSession: async () => ({ sessionId: "s_1", providerId: "drift" }),
    async *execute() {
      const text = replies[Math.min(call, replies.length - 1)] as string;
      call += 1;
      yield { type: "text-delta", text } as const;
      yield { type: "completed" } as const;
    },
    cancel: async () => undefined,
    destroySession: async () => undefined,
    health: async () => ({ available: true, providerId: "drift" }),
  };
  return { port, calls: () => call };
}

interface DataHarnessOptions {
  readonly transforms?: Readonly<Record<string, TransformFn>>;
  readonly effect?: (input: JsonValue | undefined) => JsonValue | undefined;
  readonly provider?: ProviderPort;
  readonly observability?: ObservabilityPort;
  readonly votesFor?: (
    nodeId: string,
    judgeRef: string,
  ) => Readonly<Record<string, Vote>>;
  readonly branchFor?: (
    nodeId: string,
    conditionIds: readonly string[],
  ) => string | undefined;
  readonly panel?: PanelDefinition;
}

function dataHarness(options: DataHarnessOptions = {}) {
  const dispatched: JsonValue[] = [];
  const inputs: (JsonValue | undefined)[] = [];
  const clock = { now: () => new Date("2026-08-04T00:00:00.000Z") };
  const ids = createSequentialIds();
  const checkpoints = createMemoryCheckpointStore();
  const recorder = createMemoryObservability();

  const runtime = createRuntime({
    engine: createMemoryGraphEngine(),
    policy: createMemoryPolicy({ rules: REQUIRE_APPROVAL, grants: [] }),
    approvals: createMemoryApprovalStore(clock, ids),
    provider:
      options.provider ??
      createMockProvider({
        providerId: "mock",
        events: [{ type: "completed" }],
      }),
    sandbox: createMemorySandbox({ profiles: ["docker"], available: true }),
    observability: options.observability ?? recorder,
    panel: options.panel ?? { standing: [], summonable: [], quorum: 0.5 },
    ...(options.votesFor === undefined ? {} : { votesFor: options.votesFor }),
    ...(options.branchFor === undefined
      ? {}
      : { branchFor: options.branchFor }),
    ...(options.transforms === undefined
      ? {}
      : { transforms: (ref: string) => options.transforms?.[ref] }),
    effects: {
      async perform(_runId, _nodeId, _effect, input) {
        inputs.push(input);
        const produced = options.effect?.(input);
        if (produced !== undefined) dispatched.push(produced);
        return produced;
      },
    },
    checkpoints,
    clock,
    ids,
    actor: "svc.forge.worker",
    environment: "production",
    approvalTtlMs: 7 * 24 * 60 * 60 * 1000,
  });

  return { runtime, dispatched, inputs, checkpoints, observability: recorder };
}

describe("values flow between nodes", () => {
  test("the payload reaches an effect through a transform, and its result becomes the run's", async () => {
    const forge = dataHarness({
      transforms: {
        "shape@1": (input) => ({
          text: `hello ${(input as { name: string }).name}`,
        }),
      },
      effect: (input) => ({ posted: input as JsonValue }),
    });

    const started = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { name: "ada" },
    });
    const done = await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(done.status).toBe("SUCCEEDED");
    expect(forge.inputs).toEqual([{ text: "hello ada" }]);
    expect(done.result).toEqual({ posted: { text: "hello ada" } });
  });

  test("a read narrows to a property path inside the value", async () => {
    const forge = dataHarness({
      transforms: { "shape@1": (input) => input },
      effect: (input) => input,
    });
    const artifact = sealed({
      ...dataFlow,
      nodes: dataFlow.nodes.map((node) =>
        node.id === "publish"
          ? { ...node, reads: { node: "shape", path: ["inner", "deep"] } }
          : node,
      ),
    });

    const started = await forge.runtime.start({
      artifact,
      payload: { inner: { deep: "found", other: 1 } },
    });
    await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(forge.inputs).toEqual(["found"]);
  });

  test("the run's values are checkpointed with its position", async () => {
    const forge = dataHarness({
      transforms: { "shape@1": () => ({ ready: true }) },
    });
    const run = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { name: "ada" },
    });

    const saved = await forge.checkpoints.listByRun(run.runId);
    expect(saved[0]?.values).toEqual({
      intake: { name: "ada" },
      shape: { ready: true },
    });
    // A checkpoint that a durable store cannot hold is not a checkpoint.
    expect(JSON.parse(JSON.stringify(saved[0]?.values))).toEqual(
      saved[0]?.values,
    );
  });

  test("a node with no reads is simply not in the data plane", async () => {
    const forge = dataHarness();
    const started = await forge.runtime.start({
      artifact: sealed({
        ...dataFlow,
        id: "acme.data-unread",
        nodes: dataFlow.nodes.map((node) => {
          const { reads, ...rest } = node as { reads?: unknown };
          void reads;
          return rest;
        }),
      }),
      payload: { name: "ada" },
    });
    await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(forge.inputs).toEqual([undefined]);
  });
});

describe("a node reading a value that is not there stops the run", () => {
  test("no payload means the input node produced nothing, not an empty one", async () => {
    const forge = dataHarness({
      transforms: { "shape@1": (input) => input },
    });

    const run = await forge.runtime.start({ artifact: sealed(dataFlow) });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("intake");
    expect(run.error).toContain("no value");
    expect(forge.inputs).toEqual([]);
  });

  test("a path that is not in the value is refused rather than undefined", async () => {
    const forge = dataHarness({ transforms: { "shape@1": (input) => input } });
    const artifact = sealed({
      ...dataFlow,
      nodes: dataFlow.nodes.map((node) =>
        node.id === "publish"
          ? { ...node, reads: { node: "shape", path: ["missing"] } }
          : node,
      ),
    });

    const run = await forge.runtime.start({ artifact, payload: { name: "a" } });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("no value at 'missing'");
    expect(run.pendingApprovalId).toBeUndefined();
  });

  test("a transform with no registered implementation computes nothing and stops", async () => {
    const forge = dataHarness();

    const run = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { name: "ada" },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("No transform is registered for 'shape@1'");
    expect(forge.inputs).toEqual([]);
  });

  test("an output whose source produced nothing leaves the run without a result", async () => {
    // The sink returns nothing, so `publish` has no value for `result` to read.
    const forge = dataHarness({
      transforms: { "shape@1": (input) => input },
    });
    const started = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { name: "ada" },
    });
    const done = await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(done.status).toBe("FAILED");
    expect(done.error).toContain("produced no value");
    expect(done.result).toBeUndefined();
  });

  test("a value a checkpoint could not hold is refused where it is produced", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const forge = dataHarness({
      transforms: { "shape@1": () => circular as unknown as JsonValue },
    });

    const run = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { name: "ada" },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("not JSON");
  });
});

describe("a resumed run does not change its mind", () => {
  test("an agent is asked once, so the tool acts on what the approver saw", async () => {
    const provider = driftingProvider(["first answer", "second answer"]);
    const forge = dataHarness({
      provider: provider.port,
      effect: (input) => input,
    });
    const artifact = sealed({
      ...dataFlow,
      id: "acme.data-agent",
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        { id: "draft", kind: "agent", promptRef: "p@1" },
        {
          id: "gate",
          kind: "approval",
          gateSchemaRef: "g@1",
          gates: ["publish"],
        },
        {
          id: "publish",
          kind: "tool",
          skillRef: "t@1",
          effect: "slack.post",
          reads: { node: "draft" },
        },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [
        { from: "intake", to: "draft" },
        { from: "draft", to: "gate" },
        { from: "gate", to: "publish" },
        { from: "publish", to: "result" },
      ],
    });

    const started = await forge.runtime.start({ artifact });
    expect(started.status).toBe("AWAITING_APPROVAL");
    expect(provider.calls()).toBe(1);

    await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    // Not "second answer": the resumed walk replayed the pinned output rather
    // than asking the model again.
    expect(provider.calls()).toBe(1);
    expect(forge.inputs).toEqual(["first answer"]);
  });

  test("a transform is computed once, however many attempts re-walk it", async () => {
    let computed = 0;
    const forge = dataHarness({
      transforms: {
        "shape@1": () => {
          computed += 1;
          return { attempt: computed };
        },
      },
      effect: (input) => input,
    });

    const started = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { name: "ada" },
    });
    await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(computed).toBe(1);
    expect(forge.inputs).toEqual([{ attempt: 1 }]);
  });

  test("a failed agent is not pinned, so a retry may ask again", async () => {
    let call = 0;
    const flaky: ProviderPort = {
      providerId: "flaky",
      capabilities: ["streaming"],
      createSession: async () => ({ sessionId: "s", providerId: "flaky" }),
      resumeSession: async () => ({ sessionId: "s", providerId: "flaky" }),
      async *execute() {
        call += 1;
        if (call === 1) {
          yield {
            type: "error",
            code: "PROVIDER_TIMEOUT",
            message: "timed out",
            retryable: true,
          } as const;
          return;
        }
        yield { type: "text-delta", text: "recovered" } as const;
        yield { type: "completed" } as const;
      },
      cancel: async () => undefined,
      destroySession: async () => undefined,
      health: async () => ({ available: true, providerId: "flaky" }),
    };
    const forge = dataHarness({ provider: flaky, effect: (input) => input });
    const artifact = sealed({
      ...dataFlow,
      id: "acme.data-retry",
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s@1" },
        {
          id: "draft",
          kind: "agent",
          promptRef: "p@1",
          retry: { maxAttempts: 2 },
        },
        {
          id: "gate",
          kind: "approval",
          gateSchemaRef: "g@1",
          gates: ["publish"],
        },
        {
          id: "publish",
          kind: "tool",
          skillRef: "t@1",
          effect: "slack.post",
          reads: { node: "draft" },
        },
        { id: "result", kind: "output", schemaRef: "s@1" },
      ],
      edges: [
        { from: "intake", to: "draft" },
        { from: "draft", to: "gate" },
        { from: "gate", to: "publish" },
        { from: "publish", to: "result" },
      ],
    });

    const started = await forge.runtime.start({ artifact });
    await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(call).toBe(2);
    expect(forge.inputs).toEqual(["recovered"]);
  });
});

describe("a branch and a judge can decide from run state", () => {
  const routedByData = {
    id: "acme.route",
    version: "1.0.0",
    sideEffects: ["slack.post"],
    nodes: [
      { id: "intake", kind: "input", schemaRef: "s@1" },
      {
        id: "route",
        kind: "branch",
        conditionIds: ["send", "hold"],
        reads: { node: "intake", path: ["arm"] },
      },
      {
        id: "gate",
        kind: "approval",
        gateSchemaRef: "g@1",
        gates: ["publish"],
      },
      { id: "publish", kind: "tool", skillRef: "t@1", effect: "slack.post" },
      { id: "quiet", kind: "transform", transformRef: "noop@1" },
      { id: "result", kind: "output", schemaRef: "s@1" },
    ],
    edges: [
      { from: "intake", to: "route" },
      { from: "route", to: "gate", conditionId: "send" },
      { from: "route", to: "quiet", conditionId: "hold" },
      { from: "gate", to: "publish" },
      { from: "publish", to: "result" },
      { from: "quiet", to: "result" },
    ],
  } as const;

  test("a value names the arm the branch takes", async () => {
    const forge = dataHarness();
    const run = await forge.runtime.start({
      artifact: sealed(routedByData),
      payload: { arm: "hold" },
    });

    expect(run.status).toBe("SUCCEEDED");
    expect(forge.inputs).toEqual([]);
  });

  test("the other value takes the other arm, and still meets the gate", async () => {
    const forge = dataHarness();
    const run = await forge.runtime.start({
      artifact: sealed(routedByData),
      payload: { arm: "send" },
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
  });

  test("an injected arm overrides the one run state proposed", async () => {
    const forge = dataHarness({ branchFor: () => "hold" });
    const run = await forge.runtime.start({
      artifact: sealed(routedByData),
      payload: { arm: "send" },
    });

    expect(run.status).toBe("SUCCEEDED");
  });

  test("a value that is not a declared arm is refused, not followed", async () => {
    const forge = dataHarness();
    const run = await forge.runtime.start({
      artifact: sealed(routedByData),
      payload: { arm: "whatever" },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("not declared");
  });

  test("a value that is not even a string names no arm at all", async () => {
    const forge = dataHarness();
    const run = await forge.runtime.start({
      artifact: sealed(routedByData),
      payload: { arm: 7 },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("does not name an arm");
  });

  const judgedByData = {
    id: "acme.judged",
    version: "1.0.0",
    sideEffects: ["slack.post"],
    roles: {
      writer: {
        version: "1.0.0",
        capabilities: { requires: [], forbids: [] },
        review: { weight: 1, blocking: true },
      },
    },
    nodes: [
      { id: "intake", kind: "input", schemaRef: "s@1" },
      {
        id: "panel",
        kind: "judge",
        judgeRef: "j@1",
        reads: { node: "intake", path: ["votes"] },
      },
      {
        id: "gate",
        kind: "approval",
        gateSchemaRef: "g@1",
        gates: ["publish"],
      },
      { id: "publish", kind: "tool", skillRef: "t@1", effect: "slack.post" },
      { id: "result", kind: "output", schemaRef: "s@1" },
    ],
    edges: [
      { from: "intake", to: "panel" },
      { from: "panel", to: "gate" },
      { from: "gate", to: "publish" },
      { from: "publish", to: "result" },
    ],
  } as const;

  test("votes read from run state are resolved by the panel, not taken as a verdict", async () => {
    const forge = dataHarness({
      panel: { standing: ["writer"], summonable: [], quorum: 0.5 },
    });
    const run = await forge.runtime.start({
      artifact: sealed(judgedByData),
      payload: { votes: { writer: "pass" } },
    });

    expect(run.status).toBe("AWAITING_APPROVAL");
  });

  test("a failing vote read from run state still stops the run", async () => {
    const forge = dataHarness({
      panel: { standing: ["writer"], summonable: [], quorum: 0.5 },
    });
    const run = await forge.runtime.start({
      artifact: sealed(judgedByData),
      payload: { votes: { writer: "fail" } },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("judge verdict fail");
  });

  test("a value that is not a set of votes is refused rather than interpreted", async () => {
    const forge = dataHarness({
      panel: { standing: ["writer"], summonable: [], quorum: 0.5 },
    });
    const run = await forge.runtime.start({
      artifact: sealed(judgedByData),
      payload: { votes: { writer: "yes please" } },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("not a set of votes");
  });

  test("injected votes override the ones run state proposed", async () => {
    const forge = dataHarness({
      panel: { standing: ["writer"], summonable: [], quorum: 0.5 },
      votesFor: () => ({ writer: "fail" }),
    });
    const run = await forge.runtime.start({
      artifact: sealed(judgedByData),
      payload: { votes: { writer: "pass" } },
    });

    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("judge verdict fail");
  });
});

/**
 * Run data is the most PII-dense thing in the system — a payroll payload is a
 * person. The adapter scrubs, but the runtime must never hand it anything to
 * scrub: this uses a raw sink precisely so a leak cannot be masked by
 * redaction downstream.
 */
describe("run data never reaches telemetry", () => {
  test("a payload carrying an email and an SSN appears nowhere in the stream", async () => {
    const recorded: { name: string; attributes: unknown }[] = [];
    const raw: ObservabilityPort = {
      startSpan(name, attributes) {
        const entry = { name, attributes: { ...attributes } };
        recorded.push(entry);
        return {
          end(endAttributes) {
            recorded.push({ name: `${name}:end`, attributes: endAttributes });
          },
        };
      },
      event(name, attributes) {
        recorded.push({ name, attributes });
      },
    };
    const forge = dataHarness({
      observability: raw,
      transforms: { "shape@1": (input) => input },
      effect: (input) => input,
    });

    const started = await forge.runtime.start({
      artifact: sealed(dataFlow),
      payload: { email: "ada@example.test", ssn: "123-45-6789" },
    });
    await forge.runtime.decide(
      started.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    // The effect did happen on that data — this is not a run that quietly did
    // nothing and therefore leaked nothing.
    expect(forge.inputs).toEqual([
      { email: "ada@example.test", ssn: "123-45-6789" },
    ]);

    const serialised = JSON.stringify(recorded);
    expect(serialised).not.toContain("ada@example.test");
    expect(serialised).not.toContain("123-45-6789");
  });
});

/**
 * 010 §10 makes the runtime the owner of the sandbox lifecycle, and the point
 * of owning it is that the work happens inside. Until the lease spanned the
 * walk, a workflow declaring a sandbox provisioned one, released it, and then
 * ran every step on the host.
 */
describe("a sandbox is a scope the run executes inside", () => {
  /** The sandboxes a run entered, in order, out of its own telemetry. */
  function entered(
    observability: ReturnType<typeof createMemoryObservability>,
  ): readonly string[] {
    return observability.events
      .filter((event) => event.name === "forge.node.sandbox")
      .map((event) => event.attributes.sandboxId)
      .filter((id): id is string => typeof id === "string");
  }

  test("an agent inside the scope works in the lease's workspace, not the host's", async () => {
    const { runtime, workspaces } = reviewHarness({
      votes: { writer: "pass" },
    });

    await runtime.start({ artifact: reviewedArtifact() });

    // The lease's own workspace. `/workspace/<runId>` here would mean the
    // session ran beside the sandbox rather than in it.
    expect(workspaces).toEqual(["/workspace"]);
  });

  test("the lease is released before the run parks at its gate", async () => {
    const { runtime, sandbox, observability } = reviewHarness({
      votes: { writer: "pass" },
    });

    const run = await runtime.start({ artifact: reviewedArtifact() });

    expect(run.status).toBe("AWAITING_APPROVAL");
    const leases = entered(observability);
    expect(leases).toHaveLength(1);
    // A container must not sit idle across a decision that may take days.
    expect(sandbox.isReleased(leases[0] as string)).toBe(true);
  });

  test("resuming takes a new lease rather than one held across the decision", async () => {
    const { runtime, sandbox, dispatched, observability } = reviewHarness({
      votes: { writer: "pass" },
    });
    const parked = await runtime.start({ artifact: reviewedArtifact() });

    const run = await runtime.decide(
      parked.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    expect(run.status).toBe("SUCCEEDED");
    // Still exactly once, though the walk entered a sandbox twice.
    expect(dispatched).toEqual(["slack.post"]);
    const leases = entered(observability);
    expect(leases).toHaveLength(2);
    expect(new Set(leases).size).toBe(2);
    for (const lease of leases) expect(sandbox.isReleased(lease)).toBe(true);
  });

  test("a value pinned inside a sandbox is not recomputed when the run re-enters one", async () => {
    const { runtime, workspaces } = reviewHarness({
      votes: { writer: "pass" },
    });
    const parked = await runtime.start({ artifact: reviewedArtifact() });

    await runtime.decide(
      parked.pendingApprovalId as string,
      { kind: "approve" },
      "marketing-lead",
    );

    // One session, though two leases: the resumed walk replayed the agent's
    // pinned value rather than asking the provider again inside a fresh
    // sandbox, so the action performed is the action that was approved.
    expect(workspaces).toEqual(["/workspace"]);
  });

  test("a failure inside the scope still releases every lease the run took", async () => {
    const { runtime, sandbox, observability } = reviewHarness({
      votes: { writer: "pass" },
      providerFails: true,
    });

    const run = await runtime.start({ artifact: reviewedArtifact() });

    expect(run.status).toBe("FAILED");
    // One per attempt: the retry budget is 3, and each attempt re-enters.
    const leases = entered(observability);
    expect(leases).toHaveLength(3);
    for (const lease of leases) expect(sandbox.isReleased(lease)).toBe(true);
  });

  test("a sandbox that cannot be provisioned runs nothing inside it", async () => {
    const { runtime, workspaces, dispatched, observability } = reviewHarness({
      votes: { writer: "pass" },
      sandboxAvailable: false,
    });

    const run = await runtime.start({ artifact: reviewedArtifact() });

    expect(run.status).toBe("FAILED");
    // Not one host session, not one effect: the scope never opened.
    expect(workspaces).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(entered(observability)).toEqual([]);
    expect(
      observability.events.filter(
        (event) => event.name === "forge.node.sandbox",
      )[0]?.attributes,
    ).toMatchObject({ available: false, profile: "docker" });
  });
});
