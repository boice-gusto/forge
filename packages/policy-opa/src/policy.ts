import { readFileSync } from "node:fs";
import type { PolicyDecision, PolicyPort, PolicyRequest } from "@forge/ports";
import { FORGE_POLICY_IDS } from "@forge/ports";
import { loadPolicy } from "@open-policy-agent/opa-wasm";

/**
 * OPA-backed policy evaluator (ADR-007).
 *
 * Rego compiled to WebAssembly, evaluated in-process. The rules a company
 * policy pack declares are supplied as OPA *data* rather than generated into
 * Rego, so a pack cannot author policy language — 009 §11: policies are
 * versioned and testable, and not prompt-authored.
 *
 * The compiled module is committed at `policy/forge.wasm`; see
 * `scripts/build-wasm.sh`. Nothing on the test or CI path needs the `opa`
 * binary.
 */

/** The rule shape a company policy pack declares (`@forge/manifest`). */
export interface OpaPolicyRule {
  readonly id: string;
  readonly action: string;
  /** Absent means the rule is unscoped and matches every environment. */
  readonly environment?: string | undefined;
  readonly decision: "allow" | "deny" | "require-approval";
  readonly reason: string;
  readonly approvers?: readonly string[] | undefined;
}

export interface OpaPolicyOptions {
  readonly rules: readonly OpaPolicyRule[];
  readonly grants: readonly string[];
  /**
   * A compiled Rego bundle, for a company that ships its own. It must export
   * `forge/policy/decision` and answer the shape below. Defaults to the module
   * compiled from `policy/forge.rego`.
   */
  readonly wasm?: Uint8Array;
}

const ENTRYPOINT = "forge/policy/decision";

const DEFAULT_WASM = new URL("../policy/forge.wasm", import.meta.url);

/**
 * The same policy id `@forge/policy-memory` uses, so an operator reading a
 * denial does not have to know which adapter produced it.
 */
const EVALUATOR_ERROR: PolicyDecision = {
  kind: "deny",
  reason: "Policy evaluation failed; failing closed.",
  policyId: FORGE_POLICY_IDS.evaluatorError,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Policy result field "${field}" is not a string.`);
  }
  return value;
}

function requireStrings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`Policy result field "${field}" is not a list of names.`);
  return value as readonly string[];
}

/**
 * Rebuilds the decision from the module's output rather than handing it
 * through. The bundle may be one a company compiled, so anything unrecognised
 * has to become an evaluator error — an unknown `kind` reaching the runtime
 * would be read as neither an allow nor a gate, and the safe reading of "I do
 * not understand this decision" is deny.
 */
function toDecision(raw: unknown): PolicyDecision {
  const value = (raw as readonly { readonly result?: unknown }[])[0]?.result;
  if (!isRecord(value)) throw new Error("Policy returned no decision object.");

  if (value.kind === "allow") return { kind: "allow" };
  if (value.kind === "deny") {
    return {
      kind: "deny",
      reason: requireString(value.reason, "reason"),
      policyId: requireString(value.policyId, "policyId"),
    };
  }
  if (value.kind === "require-approval") {
    return {
      kind: "require-approval",
      reason: requireString(value.reason, "reason"),
      policyId: requireString(value.policyId, "policyId"),
      approvers: requireStrings(value.approvers, "approvers"),
    };
  }
  throw new Error(`Policy returned an unknown decision kind.`);
}

export async function createOpaPolicy(
  options: OpaPolicyOptions,
): Promise<PolicyPort> {
  const grants = [...new Set(options.grants)].sort();
  const evaluator = await loadPolicy(
    options.wasm ?? readFileSync(DEFAULT_WASM),
  );

  // Set once, at construction. Data is the compiled form of the company's
  // policy packs; nothing a request carries can add to it.
  evaluator.setData({
    config: {
      grants,
      rules: options.rules.map((rule) => ({
        id: rule.id,
        action: rule.action,
        // Dropped by JSON serialisation when absent, which is how the module
        // tells an unscoped rule from one scoped to an environment.
        environment: rule.environment,
        decision: rule.decision,
        reason: rule.reason,
        approvers: rule.approvers === undefined ? [] : [...rule.approvers],
      })),
    },
  });

  return {
    async decide(request: PolicyRequest): Promise<PolicyDecision> {
      try {
        // Projected field by field on purpose. Handing the request object
        // through would let anything else riding on it reach the evaluator,
        // and "a prompt cannot override policy" rests on this input being
        // exactly the four fields the port declares.
        const raw: unknown = evaluator.evaluate(
          {
            actor: request.actor,
            action: request.action,
            environment: request.environment,
            capabilities: [...request.capabilities],
          },
          ENTRYPOINT,
        );
        return toDecision(raw);
      } catch {
        // `opa-wasm` throws bare strings as well as Errors, so this catches
        // everything. An evaluator error is a deny (ADR-007), and it is a deny
        // here rather than a rethrow so a caller cannot forget to handle it.
        return EVALUATOR_ERROR;
      }
    },

    async grantedCapabilities() {
      // The host's closure, not the module's. Reading it back out of Wasm
      // would make a bundle able to widen the grant it is being checked
      // against.
      return grants;
    },
  };
}
