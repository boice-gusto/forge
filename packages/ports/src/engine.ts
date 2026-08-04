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

export interface EngineRunContext {
  readonly runId: string;
  /**
   * Performing an effect is the engine asking the host to do something real.
   * The runtime only supplies a sink for effects it has authorised.
   */
  perform(nodeId: string, effect: string): Promise<void>;
  /**
   * Assert a capability before a privileged step. Rejecting stops the walk;
   * the engine never proceeds past a failed assertion.
   */
  assertCapability(nodeId: string, capability: string): Promise<void>;
}

export interface GraphEnginePort {
  materialize(ir: unknown): Promise<EnginePlan>;
  /**
   * Execute from the start. Pre-interrupt nodes may re-run on a later attempt
   * (006 §8), so execution must be idempotent up to the first unauthorised
   * effect.
   */
  execute(
    plan: EnginePlan,
    context: EngineRunContext,
    authorised: AuthorisedEffects,
  ): Promise<EngineExecutionResult>;
}
