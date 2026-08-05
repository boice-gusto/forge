import { loadCompany } from "@forge/company";
import { compileToArtifact, createLocalStack } from "@forge/composition";

import {
  CLI_EXIT_CODE,
  type CliResult,
  humanResult,
  jsonResult,
} from "../output.js";

/**
 * One binary, many companies: `--company` picks which package to load and
 * nothing in core changes between them (009 §16).
 */

const FORGE_VERSION = "0.1.0";

/**
 * The capability ceiling, set here because the composition root is the only
 * place with standing to grant anything. Deliberately a constant: a
 * `--capability` flag would let the caller mint authority.
 */
const HOST_CAPABILITIES = [
  "repo.read",
  "docs.read",
  "docs.write",
  "slack.write",
  "kb.read",
] as const;

function diagnosticsResult(
  diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly path: readonly string[];
  }[],
  asJson: boolean,
): CliResult {
  const payload = {
    status: "invalid",
    code: "COMPANY_LOAD_FAILED",
    diagnostics,
  };
  return asJson
    ? jsonResult(payload, CLI_EXIT_CODE.INVALID_ARTIFACT)
    : humanResult(
        [
          `Could not load the company package — ${diagnostics.length} problem(s).`,
          ...diagnostics.map(
            (diagnostic) =>
              `  ${diagnostic.code}  ${diagnostic.path.join(".")}\n    ${diagnostic.message}`,
          ),
        ].join("\n"),
        CLI_EXIT_CODE.INVALID_ARTIFACT,
      );
}

export async function inspectCompany(
  root: string | undefined,
  asJson: boolean,
): Promise<CliResult> {
  if (root === undefined) {
    return diagnosticsResult(
      [
        {
          code: "COMPANY_ROOT_MISSING",
          message: "A --company path is required.",
          path: ["company"],
        },
      ],
      asJson,
    );
  }

  const loaded = await loadCompany({
    root,
    hostCapabilities: HOST_CAPABILITIES,
    forgeVersion: FORGE_VERSION,
  });
  if (!loaded.ok) return diagnosticsResult(loaded.diagnostics, asJson);

  const { manifest, registry, grantedCapabilities } = loaded.company;
  const payload = {
    status: "loaded",
    companyId: manifest.metadata.id,
    companyVersion: manifest.metadata.version,
    plugins: registry.plugins.map((plugin) => plugin.id),
    workflows: registry.workflows.all().map((entry) => entry.value.id),
    skills: registry.skills.all().map((entry) => entry.value.id),
    policyPacks: registry.policies.all().map((entry) => entry.value.id),
    prompts: registry.prompts.all().map((entry) => entry.value.id),
    adapters: registry.adapters.all().map((entry) => entry.value.id),
    grantedCapabilities,
  };

  return asJson
    ? jsonResult(payload)
    : humanResult(
        [
          `Loaded ${payload.companyId} ${payload.companyVersion}`,
          `  plugins      ${payload.plugins.join(", ") || "none"}`,
          `  workflows    ${payload.workflows.join(", ") || "none"}`,
          `  skills       ${payload.skills.join(", ") || "none"}`,
          `  policy packs ${payload.policyPacks.join(", ") || "none"}`,
          `  adapters     ${payload.adapters.join(", ") || "none"}`,
          `  capabilities ${payload.grantedCapabilities.join(", ") || "none"}`,
        ].join("\n"),
        CLI_EXIT_CODE.SUCCESS,
      );
}

export async function runCompanyWorkflow(
  root: string | undefined,
  workflowId: string | undefined,
  asJson: boolean,
): Promise<CliResult> {
  if (root === undefined || workflowId === undefined) {
    return diagnosticsResult(
      [
        {
          code: "COMPANY_USAGE",
          message: "Both --company <dir> and --workflow <id> are required.",
          path: ["company"],
        },
      ],
      asJson,
    );
  }

  const loaded = await loadCompany({
    root,
    hostCapabilities: HOST_CAPABILITIES,
    forgeVersion: FORGE_VERSION,
  });
  if (!loaded.ok) return diagnosticsResult(loaded.diagnostics, asJson);

  const { registry, grantedCapabilities } = loaded.company;
  const contributed = registry.workflows.get(workflowId);
  if (contributed === undefined) {
    return diagnosticsResult(
      [
        {
          code: "COMPANY_WORKFLOW_UNKNOWN",
          message: `"${workflowId}" is not registered. Available: ${
            registry.workflows
              .all()
              .map((entry) => entry.value.id)
              .join(", ") || "none"
          }.`,
          path: ["company", "workflows", workflowId],
        },
      ],
      asJson,
    );
  }

  const outcome = compileToArtifact(contributed);
  if (!outcome.ok) return diagnosticsResult(outcome.diagnostics, asJson);

  // Policy comes from the company's own packs, not from the caller.
  const stack = createLocalStack({
    rules: registry.policies.all().flatMap((entry) => [...entry.value.rules]),
    grants: [...registry.grantedCapabilities],
    environment: "production",
  });

  const run = await stack.runtime.start({
    artifact: outcome.artifact,
    capabilities: [...grantedCapabilities],
  });

  const pending =
    run.pendingApprovalId === undefined
      ? undefined
      : await stack.runtime.getApproval(run.pendingApprovalId);

  const payload = {
    status: run.status,
    runId: run.runId,
    companyId: loaded.company.manifest.metadata.id,
    workflowId: run.workflowId,
    fingerprint: run.fingerprint,
    dispatchedEffects: [...stack.dispatched],
    ...(pending === undefined
      ? {}
      : {
          awaiting: {
            approvalId: pending.approvalId,
            nodeId: pending.nodeId,
            effect: pending.effect,
            policyId: pending.policyId,
            approvers: pending.approvers,
          },
        }),
  };

  const exitCode =
    run.status === "FAILED" || run.status === "CANCELLED"
      ? CLI_EXIT_CODE.UNAVAILABLE
      : CLI_EXIT_CODE.SUCCESS;

  if (asJson) return jsonResult(payload, exitCode);

  const lines = [
    `Run ${run.runId} — ${run.status}`,
    `  company   ${payload.companyId}`,
    `  workflow  ${run.workflowId}`,
    `  effects   ${payload.dispatchedEffects.join(", ") || "none dispatched"}`,
  ];
  if (pending !== undefined) {
    lines.push(
      `  awaiting  ${pending.approvalId} on ${pending.nodeId} (${pending.effect})`,
      `  required by ${pending.policyId}; approvers ${pending.approvers.join(", ") || "unspecified"}`,
    );
  }
  return humanResult(lines.join("\n"), exitCode);
}
