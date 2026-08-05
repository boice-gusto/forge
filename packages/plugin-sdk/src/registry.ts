import type { Diagnostic } from "@forge/types";
import type { z } from "zod";

import { deepFreeze } from "./freeze.js";

/**
 * Registry facades (009 §6).
 *
 * A plugin never receives a raw collection. It receives a facade that parses on
 * insert, rejects a duplicate id, and refuses a capability outside the host
 * ceiling. Problems are recorded rather than thrown so one registration pass
 * reports every fault instead of only the first, and so a badly behaved plugin
 * cannot abort the pass for the others.
 */

export interface RegistryEntry<T> {
  readonly value: T;
  /** Which plugin contributed this, so a conflict names both sides. */
  readonly pluginId: string;
}

export interface Registry<T> {
  add(value: unknown): void;
  get(id: string): T | undefined;
  all(): readonly RegistryEntry<T>[];
}

export interface RegistryOptions<T> {
  readonly kind: string;
  readonly schema: z.ZodType<T>;
  readonly diagnostics: Diagnostic[];
  /** Capabilities the value asks for, checked against the host ceiling. */
  readonly capabilitiesOf?: (value: T) => readonly string[];
  readonly hostCapabilities: readonly string[];
}

interface MutableRegistry<T> extends Registry<T> {
  /** Set by the host before each plugin's `register` call. */
  attribute(pluginId: string): void;
}

export function createRegistry<T extends { readonly id: string }>(
  options: RegistryOptions<T>,
): MutableRegistry<T> {
  const entries = new Map<string, RegistryEntry<T>>();
  let current = "unknown";

  const report = (
    code: string,
    message: string,
    path: readonly string[],
    suggestion: string,
  ): void => {
    options.diagnostics.push({ code, message, path, suggestion });
  };

  return {
    attribute(pluginId: string): void {
      current = pluginId;
    },

    add(value: unknown): void {
      const parsed = options.schema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          report(
            "PLUGIN_INVALID",
            issue.message,
            [current, options.kind, ...issue.path.map(String)],
            "Correct the contribution so it matches the authoring schema.",
          );
        }
        return;
      }

      const entry = parsed.data;

      const existing = entries.get(entry.id);
      if (existing !== undefined) {
        report(
          "PLUGIN_DUPLICATE_ID",
          `${options.kind} "${entry.id}" is already registered by "${existing.pluginId}".`,
          [current, options.kind, entry.id],
          "One id has one owner. Rename the contribution or remove the duplicate.",
        );
        return;
      }

      // The ceiling is checked here rather than after the pass so an escalating
      // contribution never lands in the registry at all.
      const requested = options.capabilitiesOf?.(entry) ?? [];
      const beyond = requested.filter(
        (capability) => !options.hostCapabilities.includes(capability),
      );
      if (beyond.length > 0) {
        report(
          "PLUGIN_CAPABILITY_ESCALATION",
          `${options.kind} "${entry.id}" claims ${beyond.map((c) => `"${c}"`).join(", ")}, which the host did not grant.`,
          [current, options.kind, entry.id],
          "Ask the host to grant the capability, or drop the claim. A plugin cannot widen its own ceiling.",
        );
        return;
      }

      // Frozen on the way in. `all()` and `get()` hand this object back to
      // plugin code, and a validated value that can still be edited afterwards
      // was never validated — a red-team pass added `prod.write` to a stored
      // skill by pushing onto the array `all()` returned.
      entries.set(entry.id, deepFreeze({ value: entry, pluginId: current }));
    },

    get(id: string): T | undefined {
      return entries.get(id)?.value;
    },

    all(): readonly RegistryEntry<T>[] {
      return [...entries.values()];
    },
  };
}
