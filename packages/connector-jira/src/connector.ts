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
 * Jira, as an intake adapter (015 Phase 8).
 *
 * The second connector, and the point of having a second one is that it does
 * not resemble the first. Jira signs differently — a plain HMAC over the body,
 * with no version prefix and no timestamp in the digest — labels its events
 * differently, and identifies its humans by an account id rather than a member
 * id. What is identical is the shape it produces and the order it does things
 * in, which is what makes `WorkflowRequest` canonical rather than aspirational.
 *
 * It also has a weakness Slack's scheme does not, and that weakness is stated
 * here rather than discovered later: with no timestamp inside the signature,
 * a captured delivery replays forever. Deduplication is what stands in the way
 * — which is why a delivery with no stable id is refused rather than accepted.
 */

export const JIRA_CHANNEL = "jira";

const SIGNATURE_HEADER = "x-hub-signature-256";
/** GitHub-style prefix, which Jira's webhook secrets follow. */
const PREFIX = "sha256=";

export interface JiraConnectorOptions {
  /**
   * The webhook secret. Supplied by the composition root from the environment
   * or a secrets manager — never read here, and never a default.
   */
  readonly secret: string;
  /**
   * Which workflow an issue event runs, by the event name Jira sends. The
   * deployment's decision: an event this deployment does not serve is
   * `UNSUPPORTED`, not an error.
   */
  readonly workflows: Readonly<Record<string, unknown>>;
  readonly capabilities?: Readonly<Record<string, readonly string[]>>;
  readonly now?: () => Date;
}

interface JiraEvent {
  readonly webhookEvent?: unknown;
  /** Jira's delivery id. Without one there is nothing to deduplicate on. */
  readonly id?: unknown;
  readonly user?: { readonly accountId?: unknown };
  readonly issue?: { readonly key?: unknown };
}

export function createJiraConnector(options: JiraConnectorOptions): Connector {
  const now = options.now ?? (() => new Date());

  return {
    channel: JIRA_CHANNEL,

    async verify(delivery): Promise<Outcome<VerifiedDelivery>> {
      const presented = delivery.headers[SIGNATURE_HEADER];
      if (presented === undefined) {
        return reject("UNVERIFIED", "signature header absent");
      }
      if (!presented.startsWith(PREFIX)) {
        return reject("UNVERIFIED", "unexpected signature encoding");
      }

      const matches = signatureMatches({
        body: delivery.body,
        secret: options.secret,
        presented: presented.slice(PREFIX.length),
      });
      if (!matches) return reject("UNVERIFIED", "signature did not match");

      // Parsed only now, as in every connector: a JSON parser is a great deal
      // of code to put in front of an unauthenticated caller.
      let body: unknown;
      try {
        body = JSON.parse(delivery.body);
      } catch {
        return reject("MALFORMED", "verified body is not JSON");
      }

      const event = body as JiraEvent;
      const id = event.id;
      /**
       * Jira sends `id` as a number. Coerced deliberately and narrowly rather
       * than accepting anything stringifiable — `String({})` is
       * `"[object Object]"`, which is a perfectly stable key for every
       * malformed delivery there will ever be, and they would deduplicate
       * against each other.
       */
      const externalId =
        typeof id === "number" && Number.isFinite(id)
          ? String(id)
          : typeof id === "string" && id !== ""
            ? id
            : undefined;
      if (externalId === undefined) {
        // Without a stable id there is no deduplication, and this scheme has
        // no replay window — so an undeduplicable delivery is refused.
        return reject("MALFORMED", "no id to deduplicate on");
      }

      const accountId = event.user?.accountId;
      return accept({
        origin: {
          channel: JIRA_CHANNEL,
          externalId,
          externalActor: typeof accountId === "string" ? accountId : "unknown",
          receivedAt: now().toISOString(),
        },
        body,
      });
    },

    async normalise(delivery): Promise<Outcome<WorkflowRequest>> {
      const event = delivery.body as JiraEvent;
      const name = event.webhookEvent;
      if (typeof name !== "string") {
        return reject("MALFORMED", "event without a webhookEvent");
      }

      const workflow = options.workflows[name];
      if (workflow === undefined) {
        // Most of a busy project's webhook traffic. Not a failure.
        return reject("UNSUPPORTED", `no workflow for '${name}'`);
      }

      /**
       * The issue key, and nothing else from the event.
       *
       * A Jira issue body carries whatever a human typed, which for a payroll
       * product routinely includes a customer's name and a screenshot of
       * their account. Forwarding the event wholesale into a run's payload
       * would put it in the run store, in the audit trail, and in front of an
       * approver who did not need it. The key is enough to look the issue up
       * from a workflow that is allowed to.
       */
      const key = event.issue?.key;
      return accept({
        workflow: workflow as WorkflowRequest["workflow"],
        capabilities: options.capabilities?.[name] ?? [],
        changedPaths: [],
        ...(typeof key === "string" ? { payload: { issueKey: key } } : {}),
        origin: delivery.origin,
      });
    },
  };
}
