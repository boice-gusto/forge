import type { JsonValue, RunValues } from "./data.js";

declare const EnginePlanBrand: unique symbol;

/**
 * Opaque lowered plan. Only an engine adapter may construct or read one; the
 * runtime treats it as a token (004 §EnginePlan opacity).
 */
export type EnginePlan = { readonly [EnginePlanBrand]: true };

/** Effects the runtime has already authorised for this attempt. */
export type AuthorisedEffects = ReadonlySet<string>;

export type EngineExecutionResult =
  | { readonly kind: "succeeded"; readonly visited: readonly string[] }
  | {
      readonly kind: "interrupted";
      readonly nodeId: string;
      readonly effect: string;
      readonly gateIds: readonly string[];
      readonly visited: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly nodeId: string;
      readonly reason: string;
      readonly retryable: boolean;
    };

/**
 * Every hook that produces a value pins it against the run, so a resumed
 * attempt re-walking a pre-interrupt node reports what it reported the first
 * time rather than asking again. The engine calls the hook either way; the
 * runtime decides whether that call reaches a provider.
 */
export interface EngineRunContext {
  readonly runId: string;
  /**
   * Do something real, on the value the node was told to read. Only supplied
   * for effects the runtime authorised.
   */
  perform(
    nodeId: string,
    effect: string,
    input: JsonValue | undefined,
  ): Promise<void>;
  /** Assert a capability before a privileged step. Rejecting stops the walk. */
  assertCapability(nodeId: string, capability: string): Promise<void>;
  /**
   * Must return one of `conditionIds`; anything else stops the walk. There is
   * no "run every arm" fallback — a workflow that says *block or publish* must
   * not do both.
   *
   * `fromState` is the value the branch read, when it declared one. An
   * explicitly injected arm wins over it, so a review adapter stays the
   * authority on a decision run data merely proposes.
   */
  chooseBranch(
    nodeId: string,
    conditionIds: readonly string[],
    fromState: JsonValue | undefined,
  ): Promise<string>;
  /** Run an agent step against the provider. Rejecting stops the walk. */
  invokeAgent(
    nodeId: string,
    promptRef: string,
    role: string | undefined,
  ): Promise<void>;
  /** Compute a value from the one the node read. Rejecting stops the walk. */
  transform(
    nodeId: string,
    transformRef: string,
    input: JsonValue,
  ): Promise<void>;
  /**
   * Score an artifact. Fails closed: a verdict with no declared arm stops the
   * walk. `fromState` carries the votes a judge read, when it declared a
   * source; injected votes win over it.
   */
  judge(
    nodeId: string,
    judgeRef: string,
    fromState: JsonValue | undefined,
  ): Promise<JudgeVerdict>;
  /** Acquire disposable compute. Unavailable means stop, never host fallback. */
  enterSandbox(nodeId: string, profile: string): Promise<void>;
  /** The value this output node resolved to becomes the run's result. */
  emitOutput(nodeId: string, value: JsonValue): Promise<void>;
}

export interface GraphEnginePort {
  materialize(ir: unknown): Promise<EnginePlan>;
  /**
   * Executes from the start every time, so a later attempt re-walks
   * pre-interrupt nodes (006 §8): idempotent up to the first unauthorised
   * effect.
   */
  execute(
    plan: EnginePlan,
    context: EngineRunContext,
    authorised: AuthorisedEffects,
    values: RunValues,
  ): Promise<EngineExecutionResult>;
}

/** Verdict a judge node returns. A verdict the judge declared no arm for stops the walk. */
export type JudgeVerdict = "pass" | "fail" | "review";
