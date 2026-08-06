import type { JsonValue } from "@forge/ports";

/**
 * The one shape a workflow run is asked for in, whatever asked.
 *
 * The CLI, the API, a Jira comment, a Slack shortcut and a signed Buzz room
 * event all produce exactly this, and the control plane cannot tell which it
 * came from except by reading {@link RequestOrigin}. That is the whole point
 * of 015 Phase 8: connectors are intake adapters, not second front doors. A
 * connector that could reach past this and hand the runtime something of its
 * own would be a second implementation of "what may run", and the invariant
 * this system exists for holds at exactly one of those.
 */
export interface WorkflowRequest {
  /**
   * Workflow source, compiled by the core. Untyped here on purpose: `@forge/
   * intake` sits beside the compiler, not above it, and a connector that
   * pre-compiled would be deciding what is runnable.
   */
  readonly workflow: JsonValue;
  /**
   * What the run may do. Requested here and *granted* by the deployment's
   * policy closure — a connector asking for more than the company granted
   * gets less, and nothing here can widen a ceiling.
   */
  readonly capabilities: readonly string[];
  readonly changedPaths: readonly string[];
  /**
   * Absent stays absent. An omitted payload must not become an empty object,
   * or a node reading one proceeds on data nobody sent.
   */
  readonly payload?: JsonValue | undefined;
  readonly origin: RequestOrigin;
}

/**
 * Where a request came from, in the terms of the system it came from.
 *
 * Carried rather than flattened into the payload because three different
 * things need it and none of them can reconstruct it: deduplication keys on
 * `channel` and `externalId`, the audit trail records who asked in a form
 * their own system can be searched by, and an operator reading a run at three
 * in the morning needs to know whether a human typed it or a webhook fired.
 */
export interface RequestOrigin {
  /** The connector's own id — `api`, `cli`, `jira`, `slack`, `buzz`. */
  readonly channel: string;
  /**
   * The event's identifier *in the originating system*: a Jira webhook id, a
   * Slack event id, a Buzz relay sequence. Not generated here — an id this
   * process invented would be different on a redelivery, which is the one
   * case deduplication exists for.
   */
  readonly externalId: string;
  /**
   * Who asked, as the originating system names them. Deliberately *not* a
   * Forge principal: mapping an external identity onto an internal one is an
   * authorisation decision, and it is made by the control plane against its
   * own directory, never by the connector that carried the message.
   */
  readonly externalActor: string;
  readonly receivedAt: string;
}

/**
 * Why a delivery was not accepted.
 *
 * A value, never a thrown error. Everything reaching a connector is untrusted
 * input from a public endpoint, and a rejection is the *expected* outcome for
 * a great deal of it — a throw would make the ordinary case indistinguishable
 * from a bug, and the temptation would be to catch broadly and carry on.
 */
export interface Rejection {
  readonly ok: false;
  /** Stable, so an operator can count them. */
  readonly code: RejectionCode;
  /**
   * For a log, not for the caller. A connector answers an untrusted sender
   * with as little as it can: telling a forged signature *why* it failed is
   * telling an attacker how to succeed.
   */
  readonly detail: string;
}

export type RejectionCode =
  /** The signature or token did not verify. Nothing after this is trusted. */
  | "UNVERIFIED"
  /** Verified, and already seen. Not an error — the correct outcome. */
  | "DUPLICATE"
  /** Verified and new, but not something this connector turns into a run. */
  | "UNSUPPORTED"
  /** Verified and meant for us, but the payload is not what it claims. */
  | "MALFORMED";

export type Accepted<T> = { readonly ok: true; readonly value: T };
export type Outcome<T> = Accepted<T> | Rejection;

export const accept = <T>(value: T): Accepted<T> => ({ ok: true, value });

export const reject = (code: RejectionCode, detail: string): Rejection => ({
  ok: false,
  code,
  detail,
});
