import {
  accept,
  type Connector,
  type Outcome,
  reject,
  signatureMatches,
  type VerifiedDelivery,
  type WorkflowRequest,
} from "@forge/intake";

/**
 * Slack, as an intake adapter and nothing more (015 Phase 8).
 *
 * It establishes that Slack sent the delivery, says whether the delivery is
 * asking Forge for a run, and stops. It does not decide whether the run may
 * happen — that is the deployment's policy, evaluated against the deployment's
 * own directory — and it does not know what a workflow is beyond carrying one.
 *
 * The workflow itself comes from the deployment, keyed by the shortcut a user
 * invoked. A connector that accepted workflow *source* over a webhook would be
 * an unauthenticated caller choosing what runs, which is the shape of every
 * remote code execution there has ever been.
 */

export const SLACK_CHANNEL = "slack";

/** Slack's own header names, so a caller does not spell them. */
const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** Slack's scheme version. Compared, not assumed. */
const VERSION = "v0";

/**
 * How far out of date a delivery may be.
 *
 * Slack's own guidance, and it is the difference between a signature check and
 * a replay defence: a correctly signed body stays correctly signed forever, so
 * without a window an attacker who captures one delivery can resend it for as
 * long as the secret lives.
 */
const MAX_SKEW_SECONDS = 60 * 5;

export interface SlackConnectorOptions {
  /**
   * Slack's signing secret. Supplied by the composition root from the
   * environment or a secrets manager — never read here, and never a default.
   */
  readonly signingSecret: string;
  /**
   * Which workflow a shortcut runs. The deployment's decision, by name: a
   * callback id Slack does not know about is `UNSUPPORTED`, not an error.
   */
  readonly workflows: Readonly<Record<string, unknown>>;
  /** Capabilities each workflow asks for; the policy closure still decides. */
  readonly capabilities?: Readonly<Record<string, readonly string[]>>;
  /** Injected so a test never has to move the system clock. */
  readonly now?: () => Date;
}

interface SlackShortcut {
  readonly type?: unknown;
  readonly callback_id?: unknown;
  readonly event_id?: unknown;
  readonly user?: { readonly id?: unknown };
  readonly payload?: unknown;
}

export function createSlackConnector(
  options: SlackConnectorOptions,
): Connector {
  const now = options.now ?? (() => new Date());

  return {
    channel: SLACK_CHANNEL,

    async verify(delivery): Promise<Outcome<VerifiedDelivery>> {
      const timestamp = delivery.headers[TIMESTAMP_HEADER];
      const presented = delivery.headers[SIGNATURE_HEADER];
      if (timestamp === undefined || presented === undefined) {
        return reject("UNVERIFIED", "signature headers absent");
      }

      const sent = Number.parseInt(timestamp, 10);
      if (!Number.isInteger(sent)) {
        return reject("UNVERIFIED", "timestamp is not a number");
      }
      const skew = Math.abs(Math.floor(now().getTime() / 1000) - sent);
      if (skew > MAX_SKEW_SECONDS) {
        // Checked *before* the digest, so a flood of stale replays costs a
        // subtraction rather than an HMAC each.
        return reject("UNVERIFIED", `timestamp is ${skew}s out of date`);
      }

      /**
       * Slack signs `v0:{timestamp}:{body}`, and the timestamp is inside the
       * digest — which is what makes the window above a defence rather than a
       * suggestion. Signing the body alone would let an attacker replay a
       * captured body under a fresh timestamp.
       */
      const [version = "", digest = ""] = presented.split("=");
      if (version !== VERSION) {
        return reject("UNVERIFIED", "unexpected signature version");
      }
      const matches = signatureMatches({
        body: `${VERSION}:${timestamp}:${delivery.body}`,
        secret: options.signingSecret,
        presented: digest,
      });
      if (!matches) return reject("UNVERIFIED", "signature did not match");

      /**
       * Parsed only now. A JSON parser is a great deal of code to put in front
       * of an unauthenticated caller, and until this line the caller was one.
       */
      let body: unknown;
      try {
        body = JSON.parse(delivery.body);
      } catch {
        return reject("MALFORMED", "verified body is not JSON");
      }

      const shortcut = body as SlackShortcut;
      const eventId = shortcut.event_id;
      if (typeof eventId !== "string" || eventId === "") {
        // No stable id means no deduplication, and a delivery that cannot be
        // deduplicated must not be accepted — Slack redelivers.
        return reject("MALFORMED", "no event_id to deduplicate on");
      }
      const userId = shortcut.user?.id;

      return accept({
        origin: {
          channel: SLACK_CHANNEL,
          externalId: eventId,
          // Slack's id for the human, not a Forge principal. Mapping one onto
          // the other is an authorisation decision, made by the control plane
          // against its own directory.
          externalActor: typeof userId === "string" ? userId : "unknown",
          receivedAt: now().toISOString(),
        },
        body,
      });
    },

    async normalise(delivery): Promise<Outcome<WorkflowRequest>> {
      const shortcut = delivery.body as SlackShortcut;
      if (shortcut.type !== "shortcut") {
        // The ordinary traffic of a busy workspace. Not a failure.
        return reject("UNSUPPORTED", `type '${String(shortcut.type)}'`);
      }

      const callbackId = shortcut.callback_id;
      if (typeof callbackId !== "string") {
        return reject("MALFORMED", "shortcut without a callback_id");
      }

      const workflow = options.workflows[callbackId];
      if (workflow === undefined) {
        // A shortcut this deployment does not serve. Refused by absence
        // rather than by a check somebody could forget: there is no path from
        // a webhook to a workflow this deployment did not name.
        return reject("UNSUPPORTED", `no workflow for '${callbackId}'`);
      }

      return accept({
        workflow: workflow as WorkflowRequest["workflow"],
        capabilities: options.capabilities?.[callbackId] ?? [],
        changedPaths: [],
        ...(shortcut.payload === undefined
          ? {}
          : { payload: shortcut.payload as WorkflowRequest["payload"] }),
        origin: delivery.origin,
      });
    },
  };
}
