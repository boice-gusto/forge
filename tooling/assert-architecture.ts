export type ArchitectureImport = {
  readonly sourcePath: string;
  readonly importedPath: string;
};

/**
 * Layer boundaries, as an executable rule rather than a convention.
 *
 * `architecture.test.ts` applies these to every import in the repository, not
 * only to hand-written examples. A rule that never runs against real source is
 * documentation wearing a test's clothes.
 */

const COMPANY_EXTENSION_PREFIXES = [
  "forge.acme",
  "forge.gusto",
  "forge.buzz",
] as const;

/**
 * A public package may import public packages only. Stated as a closed set so
 * that a newly added internal package is forbidden by default — a
 * forbidden-list instead grows a fresh hole every time a package is added.
 */
const PUBLIC_PACKAGES = ["sdk", "manifest", "types", "plugin-sdk"] as const;

/**
 * Vendors that must not appear in public or company code (009 §12). Core
 * adapters import these — that is their whole job — so the rule is scoped to
 * the layers that have to stay portable.
 */
const VENDOR_LEAKS = [
  "@langchain/",
  "langchain",
  "bullmq",
  "ioredis",
  "@anthropic-ai/",
  "@simpill/acp-llm-cli",
  "@agentclientprotocol/",
  "acpx",
  "dockerode",
  "e2b",
  // 011 §11: telemetry is a port. A company package or a public SDK reaching
  // for an exporter directly would put a vendor between Forge and its own
  // redaction, which is where every payload is stopped.
  "@opentelemetry/",
  "langsmith",
  // ADR-007: the policy engine sits behind `PolicyPort`. A company package
  // evaluating Rego itself would be authorising its own actions against a
  // bundle it also supplies, which is the capability ceiling gone.
  "@open-policy-agent/",
] as const;

/**
 * Adapter package prefixes. 004 names them `@forge/adapters-*`; this repository
 * names them by family (`provider-mock`, `policy-memory`, …). The closed public
 * set already refuses all of them, but keying only on `adapters-` meant the
 * specific, more useful error never fired for the adapters that actually exist.
 */
const PRIVATE_ADAPTER_PREFIXES = [
  "@forge/adapters-",
  "@forge/provider-",
  "@forge/engine-",
  "@forge/policy-",
  "@forge/approval-",
  "@forge/checkpoint-",
  "@forge/run-store-",
  "@forge/queue-",
  "@forge/observability-",
] as const;
const FORGE_SCOPE = "@forge/";

/**
 * Intake adapters, which 015 Phase 8 requires the core to know nothing about.
 *
 * "Core contains no connector-specific imports" is that phase's exit criterion
 * and it is the whole reason connectors are a separate layer: the moment the
 * runtime, the compiler or the API imports one, "how a request arrives" starts
 * having per-channel answers, and a second front door has been opened next to
 * the one the invariant is enforced at. A composition root may bind them —
 * that is what a composition root is for — and nothing else may name them.
 */
const CONNECTOR_PREFIX = "@forge/connector-";

/**
 * Where a connector may legitimately be named: the processes that compose a
 * deployment, and `packages/composition`, which is core's own composition
 * root and already reaches internals freely for the same reason.
 */
const COMPOSITION_ROOT = /(?:^|\/)(?:apps\/[^/]+|packages\/composition)\//;

// Match `packages/` whether or not a leading segment precedes it, so the
// rules keep firing regardless of repository layout. A path-shape change must
// never be able to silently disable an architecture boundary.
const CORE_PACKAGE = /(?:^|\/)packages\//;
const PUBLIC_PACKAGE = new RegExp(
  `(?:^|/)packages/(${PUBLIC_PACKAGES.join("|")})/`,
);
// `examples/*` holds company packages that happen to live in this repository
// (009 §3). They are bound by the company rules, not the core ones.
const COMPANY_PATH = new RegExp(
  `(?:^|/)(examples/[^/]+|${COMPANY_EXTENSION_PREFIXES.map((prefix) =>
    prefix.replace(".", "\\."),
  ).join("|")})/`,
);

function isCorePackage(sourcePath: string): boolean {
  return CORE_PACKAGE.test(sourcePath);
}

function isPublicPackage(sourcePath: string): boolean {
  return PUBLIC_PACKAGE.test(sourcePath);
}

/**
 * A company repository's acceptance and demo suites are its composition root:
 * they stand in for `apps/api`, bind a stack, and load the company. Core's own
 * equivalent lives in `packages/composition` and reaches internals freely for
 * the same reason.
 *
 * Shipped company code — plugins, workflows, policies, adapters — gets no such
 * licence, which is the boundary that actually matters. A harness that cannot
 * construct the host cannot test that the host refuses anything.
 */
const COMPANY_COMPOSITION_ROOT = new RegExp(
  `(?:^|/)(?:examples/[^/]+|${COMPANY_EXTENSION_PREFIXES.map((prefix) =>
    prefix.replace(".", "\\."),
  ).join("|")})/(?:acceptance|demos)/`,
);

function isCompanyPackage(sourcePath: string): boolean {
  return COMPANY_PATH.test(sourcePath);
}

function isCompanyCompositionRoot(sourcePath: string): boolean {
  return COMPANY_COMPOSITION_ROOT.test(sourcePath);
}

/** The package a `@forge/*` specifier names, or undefined if it is not one. */
function forgePackageName(importedPath: string): string | undefined {
  if (!importedPath.startsWith(FORGE_SCOPE)) return undefined;
  return importedPath.slice(FORGE_SCOPE.length).split("/")[0];
}

function isPublicSpecifier(importedPath: string): boolean {
  const name = forgePackageName(importedPath);
  return (
    name !== undefined && (PUBLIC_PACKAGES as readonly string[]).includes(name)
  );
}

function leaksVendor(importedPath: string): boolean {
  return VENDOR_LEAKS.some((vendor) =>
    vendor.endsWith("/")
      ? importedPath.startsWith(vendor)
      : importedPath === vendor,
  );
}

export function assertArchitecture({
  sourcePath,
  importedPath,
}: ArchitectureImport): void {
  const fromPublic = isPublicPackage(sourcePath);
  // A company harness is a host, not a company contribution.
  const fromCompany =
    isCompanyPackage(sourcePath) && !isCompanyCompositionRoot(sourcePath);

  // Checked before the general internal-import rule so a developer sees the
  // more specific failure.
  if (
    fromPublic &&
    PRIVATE_ADAPTER_PREFIXES.some((prefix) => importedPath.startsWith(prefix))
  ) {
    throw new Error("FORGE_PRIVATE_ADAPTER_IMPORT");
  }

  /**
   * 015 Phase 8: the core does not know what a connector is.
   *
   * A connector may import the core — that is the direction the dependency is
   * meant to run — and a composition root may import a connector, because
   * binding one is what a deployment does. Anything else naming one means the
   * core has grown a per-channel answer to "how does a request arrive", and
   * the request shape stops being canonical the moment that is true.
   */
  if (
    importedPath.startsWith(CONNECTOR_PREFIX) &&
    !COMPOSITION_ROOT.test(sourcePath) &&
    !sourcePath.includes("/connector-")
  ) {
    throw new Error("FORGE_CONNECTOR_IMPORT");
  }

  if (
    (fromPublic || fromCompany) &&
    forgePackageName(importedPath) !== undefined &&
    !isPublicSpecifier(importedPath)
  ) {
    throw new Error("FORGE_INTERNAL_IMPORT");
  }

  if (
    (fromPublic || fromCompany || isCompanyCompositionRoot(sourcePath)) &&
    leaksVendor(importedPath)
  ) {
    throw new Error("FORGE_VENDOR_LEAK");
  }

  if (
    isCorePackage(sourcePath) &&
    !fromCompany &&
    COMPANY_EXTENSION_PREFIXES.includes(
      importedPath as (typeof COMPANY_EXTENSION_PREFIXES)[number],
    )
  ) {
    throw new Error("FORGE_EXTENSION_IMPORT");
  }
}
