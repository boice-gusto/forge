/**
 * Acme's notification adapter: where a gated `slack.post` actually goes.
 *
 * A company ships this, not Forge. The manifest names it, the loader imports
 * it at boot, and a worker refuses to start without one — because a worker
 * that walks runs, passes gates and dispatches into a default no-op records
 * every action as performed and performs none of them.
 *
 * This example writes to stdout. A real one would call the vendor, and would
 * take its channel and credential from `configRef`, never from this file
 * (009 §9).
 */

export interface Dispatched {
  readonly runId: string;
  readonly nodeId: string;
  readonly effect: string;
  readonly input: unknown;
}

/** Everything this adapter was asked to do, for the example's own tests. */
export const sent: Dispatched[] = [];

export default {
  async perform(
    runId: string,
    nodeId: string,
    effect: string,
    input: unknown,
  ): Promise<undefined> {
    sent.push({ runId, nodeId, effect, input });
    process.stdout.write(
      `${JSON.stringify({ kind: "acme.notification", runId, nodeId, effect })}\n`,
    );
    return undefined;
  },
};
