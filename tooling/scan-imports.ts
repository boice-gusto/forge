import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Collect every import in the repository so the architecture rules can be
 * applied to real source rather than to hand-written examples.
 *
 * Relative specifiers are normalised to the package they land in. Otherwise
 * `../../runtime/src/index.js` would walk straight through a rule written
 * against `@forge/runtime`, and the boundary would hold only for developers
 * who did not think to try that.
 */

export interface SourceImport {
  readonly sourcePath: string;
  /** The specifier, or the `@forge/*` package a relative path resolves into. */
  readonly importedPath: string;
  readonly specifier: string;
  readonly line: number;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".git",
  ".next",
]);

// `from "x"`, `import "x"`, `import("x")`, `require("x")`.
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function* walk(directory: string): Generator<string> {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return; // A root that does not exist contributes nothing.
  }

  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      yield full;
    }
  }
}

/** The workspace package a repo-relative path belongs to, if any. */
export function packageOf(repoRelativePath: string): string | undefined {
  const parts = repoRelativePath.split("/");
  if (parts.length < 2) return undefined;
  if (parts[0] === "packages" || parts[0] === "apps" || parts[0] === "examples")
    return `${parts[0]}/${parts[1]}`;
  return undefined;
}

/**
 * A relative specifier that leaves its own package is equivalent to importing
 * that package; one that stays inside is not an architectural fact.
 */
function resolveRelative(
  sourcePath: string,
  specifier: string,
  repoRoot: string,
): string | undefined {
  const target = relative(
    repoRoot,
    resolve(dirname(join(repoRoot, sourcePath)), specifier),
  )
    .split(sep)
    .join("/");

  const from = packageOf(sourcePath);
  const to = packageOf(target);
  if (to === undefined || to === from) return undefined;

  const [scope, name] = to.split("/") as [string, string];
  return scope === "packages" ? `@forge/${name}` : to;
}

export function collectImports(
  repoRoot: string,
  roots: readonly string[],
): readonly SourceImport[] {
  const found: SourceImport[] = [];

  for (const root of roots) {
    for (const file of walk(join(repoRoot, root))) {
      const sourcePath = relative(repoRoot, file).split(sep).join("/");
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");

      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(IMPORT_PATTERN)) {
          const specifier = match[1] as string;
          const importedPath = specifier.startsWith(".")
            ? resolveRelative(sourcePath, specifier, repoRoot)
            : specifier;
          if (importedPath === undefined) continue;
          found.push({
            sourcePath,
            importedPath,
            specifier,
            line: index + 1,
          });
        }
      }
    }
  }

  return found;
}
