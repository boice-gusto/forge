import { loadCompany } from "@forge/company";
import type { PolicyRule } from "@forge/policy-memory";
import type { Diagnostic } from "@forge/types";

/**
 * Where the control plane's policy comes from.
 *
 * It used to come from the request body: `POST /v1/runs` accepted a `policy`
 * and built a stack for it, with the comment "policy comes from the request
 * only because there is no policy store yet". There is one now — it is the
 * company package's policy packs (009 §11), loaded once at boot.
 *
 * Two things were wrong with the old path, and only one of them was
 * performance. A new stack per request meant, with Postgres behind it, a new
 * connection pool and a new Redis connection per run started; that is the
 * blocker. The other is that the caller was deciding which rules governed their
 * own run, which is the same class of mistake as a `principal` field in a body.
 */

export interface DeploymentPolicy {
  /** Every rule from every pack the company registered, in pack order. */
  readonly rules: readonly PolicyRule[];
  /** Host ceiling ∩ what the manifest asked for. */
  readonly grants: readonly string[];
}

/** No company package bound. Nothing is granted and nothing is ruled on. */
export const NO_COMPANY_POLICY: DeploymentPolicy = { rules: [], grants: [] };

export interface CompanyPolicyOptions {
  readonly root: string;
  /**
   * Everything this deployment is willing to grant, before the manifest's
   * request. Read from the environment by the process entry point, never from
   * the manifest: a package that could widen its own ceiling by editing its own
   * manifest would not have one (009 §17.3).
   */
  readonly hostCapabilities: readonly string[];
  readonly forgeVersion: string;
}

export class CompanyLoadError extends Error {
  constructor(
    readonly root: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(
      `Could not load the company package at ${root}; the control plane has no policy without it. ` +
        diagnostics
          .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
          .join("; "),
    );
    this.name = "CompanyLoadError";
  }
}

/**
 * The policy this deployment enforces, from the company package it serves.
 *
 * Throws rather than degrading. A control plane that started with a half-loaded
 * company would be one whose policy packs may not have loaded — every gated
 * effect would find no rule, and an unmatched action denies, so the failure
 * would look like a workflow problem rather than a boot problem.
 */
export async function loadDeploymentPolicy(
  options: CompanyPolicyOptions,
): Promise<DeploymentPolicy> {
  const loaded = await loadCompany({
    root: options.root,
    hostCapabilities: options.hostCapabilities,
    forgeVersion: options.forgeVersion,
  });
  if (!loaded.ok) throw new CompanyLoadError(options.root, loaded.diagnostics);

  const { registry, grantedCapabilities } = loaded.company;
  return {
    // The union of the packs, not one picked per run: a rule in one pack that
    // shadows a rule in another has to be visible to the evaluator, not hidden
    // by whichever pack the caller happened to name.
    rules: registry.policies.all().flatMap((entry) => [...entry.value.rules]),
    grants: [...grantedCapabilities],
  };
}
