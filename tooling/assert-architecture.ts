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
  "@forge/queue-",
  "@forge/observability-",
] as const;
const FORGE_SCOPE = "@forge/";

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
