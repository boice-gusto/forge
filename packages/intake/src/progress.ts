import type { Connector } from "./connector.js";
import type { RequestOrigin } from "./request.js";

/**
 * What a connector may say back to the system a request came from.
 *
 * **Redacted by construction, not by a scrubber.** There is no field here for
 * a payload, an effect's input, a model's output or an approval's reason —
 * not because those are filtered on the way out, but because they cannot be
 * put in. A filter is a thing to forget or to get subtly wrong; a shape that
 * has nowhere to put a payload cannot leak one, and the place this lands is a
 * Slack channel or a Jira comment that a great many people can read.
 *
 * Identifiers and a status are enough for the job this does: telling a human
 * where their request got to, and giving them a link to the place where the
 * details actually live, behind authentication.
 */
export interface ProgressUpdate {
  readonly origin: RequestOrigin;
  readonly runId: string;
  /** The run's lifecycle status, verbatim from the record. */
  readonly status: string;
  /** Present while a human is being waited on, so a connector can link to it. */
  readonly pendingApprovalId?: string | undefined;
  /**
   * Where the run can be read *in Forge*, behind Forge's own authentication.
   * A connector posts a link, never a summary of what is behind it.
   */
  readonly runUrl: string;
}

/**
 * A connector that can also speak back to its own system.
 *
 * Optional, and separate from {@link Connector}, because intake and
 * publication are genuinely different jobs with different failure modes: one
 * has an untrusted caller on the other side and must be exact, the other has a
 * third-party API and must be expendable.
 */
export interface ProgressPublisher {
  publish(update: ProgressUpdate): Promise<void>;
}

export interface PublishingConnector extends Connector, ProgressPublisher {}

export const canPublish = (
  connector: Connector,
): connector is PublishingConnector =>
  typeof (connector as Partial<ProgressPublisher>).publish === "function";

/** How long a publisher gets before the run stops waiting on it. */
const PUBLISH_TIMEOUT_MS = 5_000;

export interface ProgressAnnouncer {
  /**
   * Never throws, never rejects, and never takes longer than its deadline.
   *
   * Returns whether the update actually landed. Swallowing a failure and
   * saying nothing was enough while nothing could act on it; now that a
   * retry exists, "it did not get there" is the one fact the caller needs and
   * the only one it cannot work out for itself.
   */
  announce(update: ProgressUpdate): Promise<boolean>;
}

/**
 * Publication, arranged so that a connector being down cannot cost anything
 * that matters (015 Phase 8's first exit criterion).
 *
 * Three properties, and each is a way a third-party API takes a system with
 * it:
 *
 * - **It fails open.** Slack returning 500 must not fail a run that has
 *   already dispatched a customer-visible effect. Telling somebody about the
 *   work is not the work.
 * - **It is bounded.** A publisher that never answers is worse than one that
 *   refuses, because a hang has no error to fail open on. Forge has already
 *   been bitten by exactly this in `health()` and `close()`.
 * - **It is not the record.** Everything here is derived from the run store,
 *   which is written before any of this runs. A publication that never
 *   happens loses a notification; the canonical state is untouched, and an
 *   operator reading `GET /v1/runs` sees what an operator should.
 *
 * What this deliberately does *not* do is retry. A retry queue for
 * notifications is a real thing to want and a real thing to build — with its
 * own durability, its own backpressure and its own ordering — and pretending
 * to have one by looping here would give the appearance without any of it.
 */
export function createProgressAnnouncer(options: {
  readonly connectors: Readonly<Record<string, Connector>>;
  /** Injected so a test can observe a failure that a run must not notice. */
  readonly onFailure?: (channel: string, error: unknown) => void;
  readonly timeoutMs?: number;
}): ProgressAnnouncer {
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;

  return {
    async announce(update) {
      const connector = options.connectors[update.origin.channel];
      /**
       * A run started at the API has no connector to tell, and that is the
       * ordinary case rather than a misconfiguration. Reported as *delivered*
       * on purpose: there was nothing to deliver, and a retry would be a
       * queue job repeating forever over a channel nobody bound.
       */
      if (connector === undefined || !canPublish(connector)) return true;

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A timeout is a failure, not a success that was slow: the update may
        // or may not have landed, and the only safe reading of "we never
        // heard" is that it did not.
        const delivered = await Promise.race([
          connector.publish(update).then(() => true),
          new Promise<boolean>((settle) => {
            timer = setTimeout(() => settle(false), timeoutMs);
          }),
        ]);
        return delivered;
      } catch (error) {
        options.onFailure?.(update.origin.channel, error);
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
