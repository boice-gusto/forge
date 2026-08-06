import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type CompanyManifest, safeLoadCompanyManifest } from "@forge/manifest";
import {
  type CompanyRegistry,
  type ForgePlugin,
  registerPlugins,
} from "@forge/plugin-sdk";
import type { Diagnostic } from "@forge/types";

/**
 * Company loader — the Discover phase (009 §4).
 *
 * Reads `forge.company.json`, resolves the plugin modules it names, and hands
 * them to the plugin host. Core owns the loader; the company owns what it
 * loads. Nothing here knows a company-specific noun.
 *
 * The host grants the ceiling. A manifest's `capabilities` is a *request* —
 * intersected with what the host offers, never added to it. A company package
 * that could widen its own grant by editing its own manifest would make the
 * ceiling self-declared.
 */

export const COMPANY_MANIFEST_FILE = "forge.company.json";

export interface LoadCompanyOptions {
  /** Directory holding `forge.company.json`. */
  readonly root: string;
  /** Everything the host is willing to grant, before the manifest's request. */
  readonly hostCapabilities: readonly string[];
  readonly forgeVersion: string;
  /** Overridable so tests load plugins without writing modules to disk. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

export interface LoadedCompany {
  readonly manifest: CompanyManifest;
  readonly registry: CompanyRegistry;
  /** Host ∩ requested. What this company may actually do. */
  readonly grantedCapabilities: readonly string[];
}

export type LoadCompanyResult =
  | { readonly ok: true; readonly company: LoadedCompany }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const failure = (
  code: string,
  message: string,
  path: readonly string[],
  suggestion: string,
): LoadCompanyResult => ({
  ok: false,
  diagnostics: [{ code, message, path, suggestion }],
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A relative specifier resolves against the company root, not the cwd. */
export function specifierFor(root: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const absolute = resolve(isAbsolute(root) ? root : resolve(root), specifier);
  return pathToFileURL(absolute).href;
}

function isPlugin(value: unknown): value is ForgePlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "manifest" in value &&
    "register" in value &&
    typeof (value as ForgePlugin).register === "function"
  );
}

/**
 * A module may default-export the plugin or export it as `plugin`. Anything
 * else is a diagnostic rather than a guess — importing a company module and
 * hunting for something plugin-shaped is how you end up registering whatever
 * happened to be exported.
 */
function pluginFrom(module: unknown): ForgePlugin | undefined {
  const candidates = [
    (module as { default?: unknown })?.default,
    (module as { plugin?: unknown })?.plugin,
  ];
  return candidates.find(isPlugin);
}

async function readManifest(
  root: string,
): Promise<{ ok: true; value: CompanyManifest } | LoadCompanyResult> {
  const path = join(root, COMPANY_MANIFEST_FILE);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return failure(
      "COMPANY_MANIFEST_UNREADABLE",
      `Could not read ${path}.`,
      ["company", root],
      `Create ${COMPANY_MANIFEST_FILE} at the company root.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return failure(
      "COMPANY_MANIFEST_UNREADABLE",
      `${path} is not valid JSON: ${messageOf(error)}`,
      ["company", root],
      "Fix the JSON syntax.",
    );
  }

  const loaded = safeLoadCompanyManifest(parsed);
  if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics };
  return { ok: true, value: loaded.value };
}

async function collectPlugins(
  manifest: CompanyManifest,
  root: string,
  importModule: (specifier: string) => Promise<unknown>,
): Promise<
  | { readonly ok: true; readonly plugins: readonly ForgePlugin[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
> {
  const plugins: ForgePlugin[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const reference of manifest.spec.plugins) {
    let module: unknown;
    try {
      module = await importModule(specifierFor(root, reference.package));
    } catch (error) {
      diagnostics.push({
        code: "COMPANY_PLUGIN_UNRESOLVED",
        message: `Could not load plugin "${reference.package}": ${messageOf(error)}`,
        path: ["company", "plugins", reference.package],
        suggestion:
          "Check the specifier in forge.company.json and that the module builds.",
      });
      continue;
    }

    const plugin = pluginFrom(module);
    if (plugin === undefined) {
      diagnostics.push({
        code: "COMPANY_PLUGIN_INVALID",
        message: `"${reference.package}" does not export a plugin.`,
        path: ["company", "plugins", reference.package],
        suggestion:
          "Export the plugin as the default export, or as a named `plugin` export.",
      });
      continue;
    }

    plugins.push(plugin);
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, plugins };
}

export async function loadCompany(
  options: LoadCompanyOptions,
): Promise<LoadCompanyResult> {
  const read = await readManifest(options.root);
  if (!("value" in read)) return read;
  const manifest = read.value;

  const importModule =
    options.importModule ??
    ((specifier) => import(specifier) as Promise<unknown>);

  const collected = await collectPlugins(manifest, options.root, importModule);
  if (!collected.ok) return collected;

  // Intersection, not union. A manifest asking for more than the host offers
  // gets less, and never gets what it asked for by asking.
  const granted =
    manifest.spec.capabilities.length === 0
      ? [...options.hostCapabilities]
      : options.hostCapabilities.filter((capability) =>
          manifest.spec.capabilities.includes(capability),
        );

  const registered = await registerPlugins(collected.plugins, {
    companyId: manifest.metadata.id,
    hostCapabilities: granted,
    forgeVersion: options.forgeVersion,
  });
  if (!registered.ok) return { ok: false, diagnostics: registered.diagnostics };

  return {
    ok: true,
    company: {
      manifest,
      registry: registered.registry,
      grantedCapabilities: granted,
    },
  };
}
