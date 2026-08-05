import type { RunEvent, RunEventStorePort } from "@forge/observability";

/**
 * `RunEventStorePort` in an array. The local stack's binding, and the reference
 * the Postgres adapter is measured against by the shared conformance suite.
 *
 * A timeline here dies with the process, which is the honest limit of the
 * in-memory stack — the same limit its run store and its checkpoints have. What
 * it buys is that the local and durable stacks serve run events through one
 * interface, so `GET /v1/runs/:runId/events` reads the same way in both.
 */
export function createMemoryRunEventStore(): RunEventStorePort {
  interface Row {
    readonly event: Omit<RunEvent, "attributes">;
    attributes: RunEvent["attributes"];
  }

  const rows: Row[] = [];
  const bySeq = new Map<number, Row>();

  return {
    async append(input) {
      // A counter, not a clock. Two events in the same millisecond must not tie
      // — a tie is a record that swaps place between two reads.
      const seq = rows.length + 1;
      const row: Row = {
        event: {
          seq,
          runId: input.runId,
          kind: input.kind,
          name: input.name,
          at: input.at,
        },
        attributes: { ...input.attributes },
      };
      rows.push(row);
      bySeq.set(seq, row);
      return seq;
    },

    async close(seq, attributes) {
      const row = bySeq.get(seq);
      if (row === undefined) return;
      row.attributes = { ...row.attributes, ...attributes };
    },

    async list(runId) {
      // Copied on the way out. A caller that mutated what it read would
      // otherwise change what the next reader sees.
      return rows
        .filter((row) => row.event.runId === runId)
        .map((row) => ({ ...row.event, attributes: { ...row.attributes } }));
    },
  };
}
