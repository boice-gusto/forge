import { readFile } from "node:fs/promises";

import { compileToArtifact, createLocalStack } from "@forge/composition";
import type { PanelDefinition, Vote } from "@forge/panel";
import type { PolicyRule } from "@forge/policy-memory";

import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

/**
 * Workflow commands.
 *
 * A run is in-memory and scoped to the process, so `run` executes until it
 * either finishes or reaches a gate, then reports. It does not pretend to
 * resume across invocations — that needs the API and a durable store, and
 * saying so is better than implying persistence that does not exist.
 */

interface WorkflowFile {
  readonly workflow: unknown;
  readonly policy?: {
    readonly rules?: readonly PolicyRule[];
    readonly grants?: readonly string[];
  };
  readonly capabilities?: readonly string[];
  readonly environment?: string;
  readonly actor?: string;
  readonly panel?: PanelDefinition;
  readonly review?: { readonly votes?: Readonly<Record<string, Vote>> };
  readonly changedPaths?: readonly string[];
}

async function readWorkflowFile(
  path: string,
): Promise<WorkflowFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    // A bare workflow source is accepted as shorthand for { workflow: ... }.
    return "workflow" in parsed
      ? (parsed as WorkflowFile)
      : { workflow: parsed };
  } catch {
    return undefined;
  }
}

function unreadable(path: string | undefined, asJson: boolean): CliResult {
  const payload = {
    status: "invalid",
    code: "WORKFLOW_INPUT_UNREADABLE",
    message:
      path === undefined
        ? "A --input path is required."
        : `Could not read a JSON workflow from ${path}.`,
  };
  return asJson
    ? jsonResult(payload, CLI_EXIT_CODE.INVALID_ARTIFACT)
    : humanResult(payload.message, CLI_EXIT_CODE.INVALID_ARTIFACT);
}

/**
 * Build the local stack a run needs. Each optional field is spread only when
 * present so an absent one keeps the stack's own default rather than
 * overwriting it with `undefined`.
 */
function stackFor(file: WorkflowFile) {
  return createLocalStack({
    rules: file.policy?.rules ?? [],
    grants: file.policy?.grants ?? [],
    ...(file.actor === undefined ? {} : { actor: file.actor }),
    ...(file.environment === undefined
      ? {}
      : { environment: file.environment }),
    ...(file.panel === undefined ? {} : { panel: file.panel }),
    ...(file.review?.votes === undefined
      ? {}
      : { votesFor: () => file.review?.votes ?? {} }),
  });
}

export async function compileWorkflowFile(
  path: string | undefined,
  asJson: boolean,
): Promise<CliResult> {
  if (path === undefined) return unreadable(path, asJson);
  const file = await readWorkflowFile(path);
  if (file === undefined) return unreadable(path, asJson);

  const outcome = compileToArtifact(file.workflow);
  if (!outcome.ok) {
    const payload = {
      status: "invalid",
      code: "WORKFLOW_COMPILE_FAILED",
      diagnostics: outcome.diagnostics,
    };
    return asJson
      ? jsonResult(payload, CLI_EXIT_CODE.INVALID_ARTIFACT)
      : humanResult(
          [
            "Compile failed. 0 artifacts produced.",
            ...outcome.diagnostics.map(
              (entry) =>
                `  ${entry.code} at ${entry.path.join(".")}\n    ${entry.message}` +
                (entry.suggestion === undefined
                  ? ""
                  : `\n    suggestion: ${entry.suggestion}`),
            ),
          ].join("\n"),
          CLI_EXIT_CODE.INVALID_ARTIFACT,
        );
  }

  const { artifact } = outcome;
  const payload = {
    status: "compiled",
    workflowId: artifact.workflowId,
    fingerprint: artifact.fingerprint,
    nodes: artifact.ir.nodes.length,
    approvalGates: artifact.ir.nodes
      .filter((node) => node.kind === "approval")
      .map((node) => node.id),
    declaredEffects: artifact.ir.sideEffects,
    roles: Object.keys(artifact.ir.roles).sort(),
  };
  return asJson
    ? jsonResult(payload)
    : humanResult(
        [
          `Compiled ${payload.workflowId}`,
          `  fingerprint      ${payload.fingerprint}`,
          `  nodes            ${payload.nodes}`,
          `  approval gates   ${payload.approvalGates.join(", ") || "none"}`,
          `  declared effects ${payload.declaredEffects.join(", ") || "none"}`,
          `  roles            ${payload.roles.join(", ") || "none"}`,
        ].join("\n"),
      );
}

/**
 * Human rendering. A gated run says what it is waiting on, who can decide it,
 * and when the gate expires — a bare "AWAITING_APPROVAL" tells the reader
 * nothing they can act on.
 */
function renderRun(
  run: {
    readonly runId: string;
    readonly status: string;
    readonly workflowId: string;
    readonly error?: string | undefined;
  },
  dispatchedEffects: readonly string[],
  pending:
    | {
        readonly approvalId: string;
        readonly nodeId: string;
        readonly effect: string;
        readonly policyId: string;
        readonly approvers: readonly string[];
        readonly expiresAt: string;
      }
    | undefined,
): string {
  const lines = [
    `Run ${run.runId} — ${run.status}`,
    `  workflow  ${run.workflowId}`,
    `  effects   ${dispatchedEffects.join(", ") || "none dispatched"}`,
  ];
  if (pending !== undefined) {
    lines.push(
      `  awaiting  ${pending.approvalId} on ${pending.nodeId} (${pending.effect})`,
      `  required by ${pending.policyId}; approvers ${pending.approvers.join(", ") || "unspecified"}`,
      `  expires   ${pending.expiresAt}`,
    );
  }
  if (run.error !== undefined) lines.push(`  error     ${run.error}`);
  return lines.join("\n");
}

export async function runWorkflowFile(
  path: string | undefined,
  asJson: boolean,
): Promise<CliResult> {
  if (path === undefined) return unreadable(path, asJson);
  const file = await readWorkflowFile(path);
  if (file === undefined) return unreadable(path, asJson);

  const outcome = compileToArtifact(file.workflow);
  if (!outcome.ok) return compileWorkflowFile(path, asJson);

  const stack = stackFor(file);

  const run = await stack.runtime.start({
    artifact: outcome.artifact,
    capabilities: file.capabilities ?? [],
    changedPaths: file.changedPaths ?? [],
  });

  const pending =
    run.pendingApprovalId === undefined
      ? undefined
      : await stack.runtime.getApproval(run.pendingApprovalId);

  const payload = {
    status: run.status,
    runId: run.runId,
    workflowId: run.workflowId,
    fingerprint: run.fingerprint,
    attempt: run.attempt,
    dispatchedEffects: [...stack.dispatched],
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(pending === undefined
      ? {}
      : {
          awaiting: {
            approvalId: pending.approvalId,
            nodeId: pending.nodeId,
            effect: pending.effect,
            policyId: pending.policyId,
            approvers: pending.approvers,
            expiresAt: pending.expiresAt,
          },
        }),
  };

  const exitCode =
    run.status === "FAILED" || run.status === "CANCELLED"
      ? CLI_EXIT_CODE.UNAVAILABLE
      : CLI_EXIT_CODE.SUCCESS;

  return asJson
    ? jsonResult(payload, exitCode)
    : humanResult(renderRun(run, payload.dispatchedEffects, pending), exitCode);
}
