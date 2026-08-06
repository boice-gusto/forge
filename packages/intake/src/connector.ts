import type { Outcome, RequestOrigin, WorkflowRequest } from "./request.js";
import { reject } from "./request.js";

/** A delivery as it arrived: bytes and headers, nothing interpreted. */
export interface RawDelivery {
  /** The body exactly as received. A parsed body cannot be signature-checked. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A delivery whose sender has been established.
 *
 * Only produced by {@link Connector.verify}, and required by
 * {@link Connector.normalise}, so the type system carries the ordering that
 * matters: nothing can be normalised out of a delivery nobody authenticated.
 * The alternative — one method that verifies and normalises together — makes
 * "did we check the signature" a question about the inside of a function
 * rather than about its signature.
 */
export interface VerifiedDelivery {
  readonly origin: RequestOrigin;
  /** Parsed only after verification, because parsing is attack surface too. */
  readonly body: unknown;
}

/**
 * An intake adapter: one external system's events, turned into Forge's one
 * request shape.
 *
 * Thin on purpose (015 Phase 8). A connector verifies who sent something,
 * says what it is, and stops. It does not decide whether the run may happen —
 * that is policy — and it does not run anything.
 */
export interface Connector {
  /** Matches {@link RequestOrigin.channel}; one connector owns one channel. */
  readonly channel: string;
  /**
   * Establish the sender, and nothing else.
   *
   * Must be constant-time against a secret where it compares one, and must
   * not parse the body before deciding — a JSON parser is a lot of code to
   * expose to an unauthenticated caller.
   */
  verify(delivery: RawDelivery): Promise<Outcome<VerifiedDelivery>>;
  /**
   * Turn a verified delivery into a request, or say why it is not one.
   *
   * `UNSUPPORTED` is the common answer and not a failure: most events in a
   * busy Slack workspace are not asking Forge for anything.
   */
  normalise(delivery: VerifiedDelivery): Promise<Outcome<WorkflowRequest>>;
}

/**
 * Remembers which deliveries have already been accepted.
 *
 * Keyed on channel and external id, because that pair is the only thing that
 * is stable across a redelivery — a content hash changes when a webhook adds
 * a field, and a locally generated id is new every time, which is precisely
 * the case this defends against.
 */
export interface IntakeLedgerPort {
  /**
   * `true` if this delivery is new and the caller now owns it.
   *
   * First write wins, and the write happens *before* the run is created, for
   * the same reason the effect claim is written before the action: a crash
   * between the two loses a request, and a crash the other way round starts
   * the same workflow twice. Losing one is recoverable — the sender retries,
   * or an operator does — and running a customer-visible workflow twice is
   * not.
   */
  claim(channel: string, externalId: string): Promise<boolean>;
}

/**
 * The whole of intake, in the order it has to happen.
 *
 * Every channel goes through this rather than composing the three steps
 * itself, so a connector cannot accidentally normalise before verifying, or
 * skip deduplication because its own events "can't" repeat. They can: every
 * webhook in production redelivers, usually while something else is already
 * on fire.
 *
 * Deduplication sits *between* verification and normalisation deliberately.
 * Before verification it would let an unauthenticated caller burn ids and
 * suppress a real event by guessing it; after normalisation the work of
 * parsing an event has already been done for a delivery that was never going
 * to be accepted.
 */
export async function acceptDelivery(
  connector: Connector,
  ledger: IntakeLedgerPort,
  delivery: RawDelivery,
): Promise<Outcome<WorkflowRequest>> {
  const verified = await connector.verify(delivery);
  if (!verified.ok) return verified;

  if (verified.value.origin.channel !== connector.channel) {
    // A connector that could stamp another channel's name on a delivery could
    // deduplicate against that channel's ids, and suppress its events.
    return reject(
      "MALFORMED",
      `connector '${connector.channel}' produced an origin for '${verified.value.origin.channel}'`,
    );
  }

  const fresh = await ledger.claim(
    verified.value.origin.channel,
    verified.value.origin.externalId,
  );
  if (!fresh) {
    return reject(
      "DUPLICATE",
      `${verified.value.origin.channel}/${verified.value.origin.externalId} was already accepted`,
    );
  }

  return connector.normalise(verified.value);
}
