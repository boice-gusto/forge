import type { ObservabilityPort, SpanAttributes } from "@forge/ports";

/**
 * One record **as the sink received it**.
 *
 * The distinction is the whole point of this package. An adapter that redacts
 * on the way in and is then asked what it remembers will always answer
 * correctly — that test proves the adapter can read its own notes, not that a
 * payload was stopped. `ObservabilitySubject.recorded()` must therefore be read
 * from the far side of whatever the adapter hands work to: the exporter for the
 * OpenTelemetry adapter, the timeline for the in-memory recorder, which is its
 * own sink and so is the weaker of the two proofs.
 */
export interface ExportedRecord {
  readonly name: string;
  readonly kind: "span" | "event";
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /**
   * How the sink identifies this record, and what it was told this record
   * hangs from. Unique per record and opaque to the suite — a real span id for
   * an exporting adapter, a sequence number for the in-memory recorder — so
   * "this node belongs to that run" is asserted against the structure the sink
   * received rather than against a `runId` attribute the caller wrote on both.
   */
  readonly spanId: string;
  readonly parentSpanId?: string;
  /**
   * Which trace the sink filed this record under.
   *
   * Separate from `spanId` because the question it answers is different: two
   * records can be unrelated as parent and child and still belong to the same
   * run, which is exactly the state a run resumed in another process is in.
   * The parent span lives in a process that has exited; only the trace is
   * shared.
   */
  readonly traceId: string;
}

/**
 * The ways a sink breaks. All four are the same requirement from the caller's
 * side — the run does not notice — but they break at different layers, and an
 * adapter that guards only the synchronous one still takes a process down when
 * a collector stops answering.
 */
export type SinkFault =
  /** The sink throws synchronously when handed work. */
  | "throws"
  /** The sink accepts the work and then reports a failure. */
  | "rejects"
  /** Nothing is listening at the configured endpoint. */
  | "unreachable"
  /** The sink accepts the work and never answers. */
  | "slow";

export interface ObservabilitySubject {
  readonly observability: ObservabilityPort;
  /** Push anything buffered to the sink. */
  flush(): Promise<void>;
  /** Flush and stop. Must resolve whatever the sink is doing. */
  shutdown(): Promise<void>;
  /**
   * What the sink holds *right now*, without flushing. Read after `flush()` or
   * `shutdown()`; read before either to observe what buffering has withheld.
   */
  recorded(): readonly ExportedRecord[];
}

export interface ObservabilityConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  create(): Promise<ObservabilitySubject>;
  /**
   * The faults this adapter can be put into. A claim under test rather than a
   * curve to be graded on: the suite requires `throws` from everyone, because
   * every adapter can fail internally, and runs whichever of the rest are
   * declared.
   */
  readonly faults: readonly SinkFault[];
  createFaulty(fault: SinkFault): Promise<ObservabilitySubject>;
}

/**
 * A run's worth of the attributes Forge is most likely to be handed and least
 * able to survive leaking. Every one of these is a plausible mistake at a call
 * site: an agent node echoing its input, an approval preview carrying the
 * record it is about to act on.
 *
 * Deliberately mixed with attributes that must *not* be scrubbed, so a suite
 * cannot be satisfied by an adapter that redacts everything.
 */
export const PII_PROBE: SpanAttributes = {
  runId: "run_1",
  nodeId: "publish",
  promptRef: "acme.publish.draft@1",
  attempt: 2,
  memberEmail: "ada.lovelace@example.test",
  ssn: "123-45-6789",
  // Decimal on purpose. A bare `82000` is five digits that appear by chance
  // inside a nanosecond timestamp, so the wire test could fail — or pass — for
  // a reason unrelated to redaction. It did fail that way once.
  annualWage: 82417.63,
  homeAddress: "1 Infinite Loop",
  // Twelve digits for the same reason: a nine-digit run is short enough to
  // collide with an id or a timestamp in a raw payload grep.
  bankAccountNumber: "000123456789",
  // Short on purpose: a longer literal here is indistinguishable from a real
  // credential to `pnpm security:secrets`, and a fixture must not train anyone
  // to ignore that check.
  apiKey: "sk-abc",
  prompt: "Summarise the payroll for ada.lovelace@example.test",
  note: "call ada.lovelace@example.test about 123-45-6789",
};

/**
 * Substrings that must appear nowhere in what the sink was handed — asserted
 * against the serialised record rather than key by key, so a payload that
 * arrives under a key nobody thought of is still caught.
 */
export const PII_NEEDLES: readonly string[] = [
  "ada.lovelace@example.test",
  "123-45-6789",
  "82417.63",
  "1 Infinite Loop",
  "000123456789",
  "sk-abc",
  "Summarise the payroll",
];

/** The identifiers a dashboard is useless without, and that are not PII. */
export const PII_PROBE_SURVIVORS: SpanAttributes = {
  runId: "run_1",
  nodeId: "publish",
  promptRef: "acme.publish.draft@1",
  attempt: 2,
};

/**
 * `forge.approval.decided` as the taxonomy defines it, plus the two shapes a
 * call site reaches for when it wants to know *who*.
 */
export const PRINCIPAL_PROBE: SpanAttributes = {
  runId: "run_1",
  approvalId: "approval_1",
  decision: "approve",
  principalHash: "9f2a5c1e4b7d0a63",
  approverCount: 2,
  principal: "ada.lovelace",
  approverId: "u_88",
  decidedBySubject: "ada.lovelace",
};

export const REDACTED = "[REDACTED]";
