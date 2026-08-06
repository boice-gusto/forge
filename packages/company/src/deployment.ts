import { createRequire } from "node:module";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { PolicyRule } from "@forge/policy-memory";
import type { Diagnostic } from "@forge/types";

import { loadCompany, specifierFor } from "./loader.js";

/**
 * Resolve an adapter's module the way the *company* would resolve it.
 *
 * A relative specifier is relative to the company root, which `specifierFor`
 * already handles. A bare one is the interesting case: imported from here it
 * resolves against `@forge/company`'s own dependencies, so a company could
 * only ever bind packages Forge itself happens to depend on — which is the
 * opposite of the point. Resolving from the company root means a company's
 * adapter can be a company's dependency.
 *
 * The fallback matters for the case where a company has no `node_modules` of
 * its own, as in a workspace where everything is hoisted. Trying the plain
 * specifier then is not a guess about *what* to load — the specifier is the
 * same string either way — only about where to look for it.
 */
function adapterSpecifier(root: string, binding: string): string {
  if (binding.startsWith(".")) return specifierFor(root, binding);
  const from = isAbsolute(root) ? root : resolvePath(root);
  try {
    return pathToFileURL(
      createRequire(pathToFileURL(`${from}/`)).resolve(binding),
    ).href;
  } catch {
    return binding;
  }
}

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
  /**
   * The adapter modules this company bound, keyed by the port they satisfy.
   *
   * Resolved here rather than described here: a manifest naming a module is
   * only a promise until something imports it, and a deployment that discovers
   * at the first gated action that its notification adapter does not exist has
   * discovered it in the worst possible place.
   *
   * Typed as `unknown` on purpose. This package has no business knowing what
   * an `EffectSink` is — that lives in the runtime, above it. The composition
   * root that binds the module is the thing that knows what shape it needs,
   * and is where a wrong shape should be a refusal to start.
   */
  readonly adapters: Readonly<Record<string, unknown>>;
}

/** No company package bound. Nothing is granted and nothing is ruled on. */
export const NO_COMPANY_POLICY: DeploymentPolicy = {
  rules: [],
  grants: [],
  adapters: {},
};

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

  /**
   * Imported at boot, in parallel, and a failure is fatal — the same stance as
   * a policy pack that will not load. A deployment that came up with half its
   * adapters would perform some gated actions and silently drop the rest, and
   * the ones it dropped would look like workflow problems.
   */
  const bound = await Promise.all(
    registry.adapters.all().map(async (entry) => {
      const specifier = adapterSpecifier(options.root, entry.value.binding);
      try {
        return [entry.value.id, await import(specifier)] as const;
      } catch (error) {
        throw new CompanyLoadError(options.root, [
          {
            code: "CO_ADAPTER_UNRESOLVED",
            message: `Adapter "${entry.value.id}" names ${entry.value.binding}, which could not be imported: ${String(error)}`,
            path: ["adapters", entry.value.id],
            suggestion:
              "Check the specifier resolves from the company package root, and that the module is built.",
          },
        ]);
      }
    }),
  );

  return {
    // The union of the packs, not one picked per run: a rule in one pack that
    // shadows a rule in another has to be visible to the evaluator, not hidden
    // by whichever pack the caller happened to name.
    rules: registry.policies.all().flatMap((entry) => [...entry.value.rules]),
    grants: [...grantedCapabilities],
    adapters: Object.fromEntries(bound),
  };
}
