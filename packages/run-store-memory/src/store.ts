import type {
  DispatchedEffect,
  JsonValue,
  PersistedRun,
  PinnedRoute,
  PinnedValue,
  RunCreateInput,
  RunRecord,
  RunStorePort,
} from "@forge/ports";

/**
 * `RunStorePort` in a Map. The local stack's binding, and the reference the
 * Postgres adapter is measured against by the shared conformance suite.
 *
 * Everything crossing the boundary is deep-copied through JSON. A caller that
 * kept a reference to what it wrote and mutated it later would otherwise
 * change what a rehydrated run believes it produced, which is precisely the
 * failure pinning exists to prevent.
 */

interface Stored {
  record: RunRecord;
  revision: number;
  readonly created: Omit<RunCreateInput, "record">;
  readonly values: Map<string, JsonValue | undefined>;
  readonly routes: Map<string, string>;
  readonly effects: DispatchedEffect[];
}

function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createMemoryRunStore(): RunStorePort {
  const runs = new Map<string, Stored>();

  const find = (runId: string): Stored => {
    const stored = runs.get(runId);
    if (stored === undefined) {
      throw new Error(`FORGE_RUN_NOT_FOUND: ${runId}`);
    }
    return stored;
  };

  return {
    async create(input) {
      if (runs.has(input.record.runId)) {
        throw new Error(`FORGE_RUN_EXISTS: ${input.record.runId}`);
      }
      runs.set(input.record.runId, {
        record: detach(input.record),
        revision: 1,
        created: detach({
          artifact: input.artifact,
          capabilities: input.capabilities,
          changedPaths: input.changedPaths,
        }),
        values: new Map(),
        routes: new Map(),
        effects: [],
      });
    },

    async load(runId) {
      const stored = runs.get(runId);
      if (stored === undefined) return undefined;

      const values: PinnedValue[] = [...stored.values].map(([nodeId, value]) =>
        // Absent stays absent: `{ nodeId }` is "ran, produced nothing", and
        // `{ nodeId, value: undefined }` would read the same but says less.
        value === undefined ? { nodeId } : { nodeId, value },
      );
      const routes: PinnedRoute[] = [...stored.routes].map(([nodeId, arm]) => ({
        nodeId,
        arm,
      }));

      const persisted: PersistedRun = {
        record: stored.record,
        revision: stored.revision,
        ...stored.created,
        values,
        routes,
        effects: stored.effects,
      };
      return detach(persisted);
    },

    async list(query) {
      // A Map iterates in insertion order, so reversing it is "most recent
      // first" without a clock — and without two runs created in the same
      // millisecond tying, which would let a run move between two reads.
      const records = [...runs.values()]
        .reverse()
        .map((stored) => stored.record);
      const status = query?.status;
      return detach(
        status === undefined
          ? records
          : records.filter((record) => record.status === status),
      );
    },

    async update(record, expectedRevision) {
      const stored = find(record.runId);
      // Refused, not merged. A caller holding a stale record cannot be told
      // which of its fields are still current, so the only safe answer is to
      // make it read again.
      if (stored.revision !== expectedRevision) {
        throw new Error(
          `FORGE_RUN_CONFLICT: ${record.runId} is at revision ${stored.revision}, not ${expectedRevision}.`,
        );
      }
      stored.record = detach(record);
      stored.revision += 1;
      return stored.revision;
    },

    async pinValue(runId, nodeId, value) {
      const stored = find(runId);
      if (stored.values.has(nodeId)) return;
      stored.values.set(
        nodeId,
        value === undefined ? undefined : detach(value),
      );
    },

    async pinRoute(runId, nodeId, arm) {
      const stored = find(runId);
      if (stored.routes.has(nodeId)) return;
      stored.routes.set(nodeId, arm);
    },

    async claimEffect(claim) {
      const stored = find(claim.runId);
      if (stored.effects.some((effect) => effect.nodeId === claim.nodeId)) {
        return false;
      }
      stored.effects.push(
        detach({
          nodeId: claim.nodeId,
          effect: claim.effect,
          ...(claim.input === undefined ? {} : { input: claim.input }),
          dispatchedAt: claim.at,
        }),
      );
      return true;
    },

    async settleEffect(runId, nodeId, at) {
      const stored = find(runId);
      const claimed = stored.effects.find(
        (effect) => effect.nodeId === nodeId,
      ) as { settledAt?: string } | undefined;
      if (claimed === undefined) {
        throw new Error(`FORGE_EFFECT_NOT_CLAIMED: ${runId}/${nodeId}`);
      }
      // First settlement wins, like every other pin here: a second one would
      // be a later process rewriting when the action actually happened.
      claimed.settledAt ??= at;
    },

    async listUnsettled(limit) {
      return [...runs.entries()]
        .flatMap(([runId, stored]) =>
          stored.effects
            .filter((effect) => effect.settledAt === undefined)
            .map((effect) => ({
              runId,
              nodeId: effect.nodeId,
              effect: effect.effect,
              claimedAt: effect.dispatchedAt,
            })),
        )
        .sort((left, right) => left.claimedAt.localeCompare(right.claimedAt))
        .slice(0, Math.max(0, limit));
    },
  };
}
