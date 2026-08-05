import type {
  ProviderCapability,
  ProviderEvent,
  ProviderExecutionRequest,
  ProviderPort,
  ProviderSession,
} from "@forge/ports";

/**
 * The situations an adapter must be able to put itself into. Conformance cannot
 * assert that a transient failure is marked retryable unless it can ask for
 * one, so an adapter proves itself by building these six rather than by
 * hand-writing the tests that follow.
 */
export type ProviderScenario =
  | "text-stream"
  | "tool-round-trip"
  | "cancellable-stream"
  | "transient-failure"
  | "permanent-failure"
  | "unavailable";

export interface ProviderConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  /**
   * A claim under test, not a curve to be graded on: the suite checks this
   * against the adapter's own `capabilities`.
   */
  readonly supports: readonly ProviderCapability[];
  /** The adapter at full strength, positioned in `scenario`. */
  create(scenario: ProviderScenario): ProviderPort | Promise<ProviderPort>;
  /**
   * The same adapter declaring only `capabilities`. Without this the suite
   * cannot check that an undeclared capability is refused, because a
   * fully-capable adapter never has one to refuse.
   */
  createRestricted(
    capabilities: readonly ProviderCapability[],
  ): ProviderPort | Promise<ProviderPort>;
}

/**
 * An exhaustive record, so adding a capability to the port is a type error here
 * rather than a silently unchecked one.
 */
export const PROVIDER_CAPABILITIES = Object.keys({
  streaming: true,
  "tool-calls": true,
  "session-resume": true,
} satisfies Record<ProviderCapability, true>) as readonly ProviderCapability[];

export const CONFORMANCE_REQUEST: ProviderExecutionRequest = {
  prompt: "Conformance probe.",
};

/**
 * A stream that never ends must fail the suite, not hang it: a provider
 * ignoring cancellation is the defect being hunted.
 */
const STREAM_EVENT_LIMIT = 100;

export interface StreamOutcome {
  readonly events: readonly ProviderEvent[];
  /** The iterator threw rather than ending. Loud, so still fail-closed. */
  readonly threw: boolean;
  /** The stream ran past the limit; treated as "did not terminate". */
  readonly overran: boolean;
}

export async function openSession(
  provider: ProviderPort,
): Promise<ProviderSession> {
  return provider.createSession({
    workspacePath: "/workspace/conformance",
    correlationId: "conformance",
    capabilities: provider.capabilities,
  });
}

export function startStream(
  provider: ProviderPort,
  session: ProviderSession,
): AsyncIterator<ProviderEvent> {
  return provider.execute(session, CONFORMANCE_REQUEST)[Symbol.asyncIterator]();
}

export async function drain(
  iterator: AsyncIterator<ProviderEvent>,
): Promise<StreamOutcome> {
  const events: ProviderEvent[] = [];
  for (;;) {
    let step: IteratorResult<ProviderEvent>;
    try {
      step = await iterator.next();
    } catch {
      return { events, threw: true, overran: false };
    }
    if (step.done === true) return { events, threw: false, overran: false };
    events.push(step.value);
    if (events.length > STREAM_EVENT_LIMIT) {
      return { events, threw: false, overran: true };
    }
  }
}

export async function runToEnd(
  provider: ProviderPort,
  session: ProviderSession,
): Promise<StreamOutcome> {
  return drain(startStream(provider, session));
}

export type TerminalEvent = Extract<
  ProviderEvent,
  { type: "completed" } | { type: "error" }
>;

export function terminalEvents(
  events: readonly ProviderEvent[],
): readonly TerminalEvent[] {
  return events.filter(
    (event): event is TerminalEvent =>
      event.type === "completed" || event.type === "error",
  );
}

export function errorEvents(
  events: readonly ProviderEvent[],
): readonly Extract<ProviderEvent, { type: "error" }>[] {
  return events.filter(
    (event): event is Extract<ProviderEvent, { type: "error" }> =>
      event.type === "error",
  );
}

export function eventTypes(
  events: readonly ProviderEvent[],
): readonly ProviderEvent["type"][] {
  return events.map((event) => event.type);
}
