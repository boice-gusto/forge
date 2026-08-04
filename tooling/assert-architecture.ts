export type ArchitectureImport = {
  readonly sourcePath: string;
  readonly importedPath: string;
};

const COMPANY_EXTENSION_PREFIXES = [
  "forge.acme",
  "forge.gusto",
  "forge.buzz",
] as const;
const PRIVATE_ADAPTER_PREFIX = "@forge/adapters-";
// Match `packages/` whether or not a leading segment precedes it, so the
// rules keep firing regardless of repository layout. A path-shape change must
// never be able to silently disable an architecture boundary.
const CORE_PACKAGE = /(?:^|\/)packages\//;
const PUBLIC_PACKAGE = /(?:^|\/)packages\/(sdk|manifest|types|plugin-sdk)\//;

function isCorePackage(sourcePath: string): boolean {
  return CORE_PACKAGE.test(sourcePath);
}

function isPublicPackage(sourcePath: string): boolean {
  return PUBLIC_PACKAGE.test(sourcePath);
}

export function assertArchitecture({
  sourcePath,
  importedPath,
}: ArchitectureImport): void {
  if (
    isPublicPackage(sourcePath) &&
    importedPath.startsWith(PRIVATE_ADAPTER_PREFIX)
  ) {
    throw new Error("FORGE_PRIVATE_ADAPTER_IMPORT");
  }

  if (
    isCorePackage(sourcePath) &&
    COMPANY_EXTENSION_PREFIXES.includes(
      importedPath as (typeof COMPANY_EXTENSION_PREFIXES)[number],
    )
  ) {
    throw new Error("FORGE_EXTENSION_IMPORT");
  }
}
