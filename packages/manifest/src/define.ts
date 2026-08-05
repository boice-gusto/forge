import {
  type WorkflowSource,
  type WorkflowSourceInput,
  WorkflowSourceSchema,
} from "@forge/types";
import type { z } from "zod";

import {
  type PolicyPack,
  type PolicyPackInput,
  PolicyPackSchema,
  type PromptAsset,
  type PromptAssetInput,
  PromptAssetSchema,
  type SkillDefinition,
  type SkillDefinitionInput,
  SkillDefinitionSchema,
} from "./authoring.js";

/**
 * The authoring surface (004 §"Package map", 007 §3, 009 §6).
 *
 * Each of these takes the *input* shape and returns the *output* shape, so an
 * author writes what they mean and gets back a value with the defaults applied,
 * and each parses at author time — a malformed definition throws where it is
 * written rather than surfacing later as a diagnostic naming the plugin.
 */

function parseOrThrow<Out>(
  schema: z.ZodType<Out>,
  value: unknown,
  what: string,
): Out {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("; ");
  throw new Error(`Invalid ${what} definition — ${detail}`);
}

/**
 * `as const` and a `const` type parameter both produce readonly arrays, and a
 * constraint that does not admit them makes TypeScript discard the literal
 * inference. Every node id would widen to `string` and every check below would
 * pass vacuously — a check that cannot fail is worse than no check.
 */
type Authored<T> = T extends readonly (infer Element)[]
  ? readonly Authored<Element>[]
  : T extends object
    ? { readonly [K in keyof T]: Authored<T[K]> }
    : T;

type WorkflowDraft = Authored<WorkflowSourceInput>;

type DeclaredNodeId<T> = T extends { readonly nodes: readonly (infer N)[] }
  ? N extends { readonly id: infer Id extends string }
    ? Id
    : never
  : never;

type DeclaredRole<T> = T extends { readonly roles: infer Roles }
  ? Extract<keyof Roles, string>
  : never;

type DeclaredEffect<T> = T extends {
  readonly sideEffects: readonly (infer Effect)[];
}
  ? Extract<Effect, string>
  : never;

/**
 * Referential integrity in the editor, not instead of the compiler. The
 * compiler still owns every one of these — `defineWorkflow` cannot reason about
 * paths, and a workflow loaded from JSON never passes through it. This only
 * buys the same answer sooner: a red squiggle on the offending line rather than
 * a `WF_UNKNOWN_REF` after a compile.
 *
 * Each property is optional so omitting it stays legal; what is refused is
 * naming something that was never declared.
 */
interface NodeReferences<T> {
  // Open, because this type is intersected with the node the author actually
  // wrote. A closed shape would make every other field of that node an excess
  // property.
  readonly [field: string]: unknown;
  readonly role?: DeclaredRole<T>;
  readonly effect?: DeclaredEffect<T>;
  readonly gates?: readonly DeclaredNodeId<T>[];
  readonly branches?: readonly DeclaredNodeId<T>[];
}

interface EdgeReferences<T> {
  readonly [field: string]: unknown;
  readonly from: DeclaredNodeId<T>;
  readonly to: DeclaredNodeId<T>;
}

interface WorkflowReferences<T> {
  readonly nodes: readonly NodeReferences<T>[];
  readonly edges: readonly EdgeReferences<T>[];
}

/**
 * Declare a workflow. The compiler remains the only path to a runnable graph;
 * this is the authoring end of it.
 */
export function defineWorkflow<const T extends WorkflowDraft>(
  source: T & WorkflowReferences<T>,
): WorkflowSource {
  return parseOrThrow(WorkflowSourceSchema, source, "workflow");
}

export function defineSkill(skill: SkillDefinitionInput): SkillDefinition {
  return parseOrThrow(SkillDefinitionSchema, skill, "skill");
}

export function definePrompt(prompt: PromptAssetInput): PromptAsset {
  return parseOrThrow(PromptAssetSchema, prompt, "prompt");
}

export function definePolicy(policy: PolicyPackInput): PolicyPack {
  return parseOrThrow(PolicyPackSchema, policy, "policy pack");
}
