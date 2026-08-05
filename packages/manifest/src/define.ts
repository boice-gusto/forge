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
 * Each of these does three things a plain object literal does not:
 *
 * 1. It accepts the *input* shape and returns the *output* shape, so an author
 *    writes what they mean and gets back a value with the defaults applied.
 * 2. It parses at author time. A malformed definition throws where it is
 *    written, instead of surfacing later as a registration diagnostic that
 *    names the plugin rather than the line.
 * 3. `defineWorkflow` additionally resolves the workflow's internal references
 *    in the type system — see below.
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
 * Referential integrity, checked by the compiler *and* by the type system.
 *
 * The compiler still owns every one of these — `defineWorkflow` cannot reason
 * about paths, and a workflow loaded from JSON never passes through it. What
 * this buys is the same answer in the editor: a mistyped edge target, a gate
 * that names a node which does not exist, an undeclared effect, or an unknown
 * role is a red squiggle on the line that caused it rather than a
 * `WF_UNKNOWN_REF` after a compile.
 *
 * Each property is optional so that omitting it stays legal — the schema's
 * defaults still apply. What is refused is naming something that was never
 * declared.
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
