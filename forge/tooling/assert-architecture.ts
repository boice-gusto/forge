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
const PUBLIC_PACKAGE_PATH = "/packages/";

function isCorePackage(sourcePath: string): boolean {
  return sourcePath.includes(PUBLIC_PACKAGE_PATH);
}

function isPublicPackage(sourcePath: string): boolean {
  return /\/packages\/(sdk|manifest|types|plugin-sdk)\//.test(sourcePath);
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
