import type {
  ApprovalView,
  ForgeClient,
  RunEventStream,
  RunEventView,
  RunView,
} from "@forge/sdk";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ApprovalInbox,
  type DecisionOutcome,
} from "./components/approval-inbox.js";
import {
  type LocalDependency,
  LocalStatus,
} from "./components/local-status.js";
import { RunInspector } from "./components/run-inspector.js";

/**
 * Composition root for the operator surfaces. It speaks to the control plane
 * through `@forge/sdk` and nothing else: the runtime's rules cannot be
 * enforced in a browser, so restating any of them here would only produce a
 * second, weaker copy.
 *
 * The inbox loads on its own, without a run id. An operator arrives knowing
 * that something needs deciding, not knowing which run needs it.
 */

export interface ForgeAppProps {
  readonly dependencies: readonly LocalDependency[];
  readonly client: ForgeClient;
  /** Freezes the countdown clock. Supplied by tests; live in the browser. */
  readonly now?: number;
}

type InboxState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loaded"; readonly approvals: readonly ApprovalView[] };

type RunState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "loaded";
      readonly run: RunView;
      readonly approvals: readonly ApprovalView[];
      readonly events: readonly RunEventView[];
    };

/** Expiry is time-sensitive, so the countdown has to move on its own. */
function useTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  return now;
}

export function ForgeApp({ dependencies, client, now }: ForgeAppProps) {
  const tick = useTick();
  const clock = now ?? tick;
  const [runIdInput, setRunIdInput] = useState("");
  const [inbox, setInbox] = useState<InboxState>({ kind: "loading" });
  const [state, setState] = useState<RunState>({ kind: "idle" });

  const loadInbox = useCallback(async (): Promise<void> => {
    const result = await client.inbox();
    setInbox(
      result.ok
        ? { kind: "loaded", approvals: result.value }
        : { kind: "error", message: `${result.code}: ${result.message}` },
    );
  }, [client]);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  /**
   * The highest sequence the screen already holds.
   *
   * It does two jobs, and they are the same job from two sides: the tail opens
   * from it, so history the snapshot already returned is not replayed; and a
   * record at or below it is dropped rather than appended, which is what keeps
   * a reload underneath an open stream from listing the same event twice.
   */
  const cursor = useRef(0);

  const load = async (runId: string): Promise<void> => {
    setState({ kind: "loading" });

    const run = await client.getRun(runId);
    if (!run.ok) {
      setState({ kind: "error", message: `${run.code}: ${run.message}` });
      return;
    }

    const approvals = await client.approvals(runId);
    if (!approvals.ok) {
      setState({
        kind: "error",
        message: `${approvals.code}: ${approvals.message}`,
      });
      return;
    }

    const events = await client.runEvents(runId);
    if (!events.ok) {
      setState({
        kind: "error",
        message: `${events.code}: ${events.message}`,
      });
      return;
    }

    cursor.current = events.value.reduce(
      (highest, event) => Math.max(highest, event.seq),
      0,
    );
    setState({
      kind: "loaded",
      run: run.value,
      approvals: approvals.value,
      events: events.value,
    });
  };

  /**
   * The run record and its gates, re-read without touching the timeline.
   *
   * The timeline has exactly one writer once a run is open — the tail — so a
   * refresh must not replace it with a second snapshot: the two would overlap
   * on everything the tail had already delivered.
   */
  const refresh = useCallback(
    async (runId: string): Promise<void> => {
      const run = await client.getRun(runId);
      const approvals = await client.approvals(runId);
      if (!run.ok || !approvals.ok) return;
      setState((current) =>
        current.kind === "loaded" && current.run.runId === runId
          ? { ...current, run: run.value, approvals: approvals.value }
          : current,
      );
    },
    [client],
  );

  const openRunId = state.kind === "loaded" ? state.run.runId : undefined;

  /**
   * Tail the open run.
   *
   * Two things make this necessary rather than pleasant. A decision now
   * returns *before* the run advances — the control plane records it, enqueues
   * the resume and replies — so a screen that re-read once after deciding
   * would show the operator a run still sitting at the gate they just cleared.
   * And a run walks in another process entirely, so there is no local event to
   * wait on. The stream is how the screen finds out.
   *
   * A record arriving does not update the run *record*, only the timeline, so
   * anything about the run itself or its gates is re-read from the control
   * plane rather than inferred from an event. The screen reports what the
   * control plane says; the stream only tells it when to ask.
   */
  useEffect(() => {
    if (openRunId === undefined) return;

    let live = true;
    let stream: RunEventStream | undefined;

    void client
      .streamRunEvents(openRunId, {
        lastEventId: cursor.current,
        onEvent: (event) => {
          if (event.seq <= cursor.current) return;
          cursor.current = event.seq;
          setState((current) =>
            current.kind === "loaded" && current.run.runId === openRunId
              ? { ...current, events: [...current.events, event] }
              : current,
          );
          if (event.kind === "run" || event.kind === "approval") {
            void refresh(openRunId);
          }
        },
      })
      .then((result) => {
        // A stream the control plane refused leaves the run readable and the
        // timeline as loaded. It is not turned into an error banner over a
        // screen that is otherwise correct.
        if (!result.ok) return;
        if (live) stream = result.value;
        else result.value.close();
      });

    return () => {
      live = false;
      stream?.close();
    };
  }, [openRunId, client, refresh]);

  const decide = async (
    runId: string,
    approvalId: string,
    decision: Parameters<ForgeClient["decide"]>[2],
  ): Promise<DecisionOutcome> => {
    const result = await client.decide(runId, approvalId, decision);
    if (!result.ok)
      return { ok: false, message: `${result.code}: ${result.message}` };

    // The gate is decided, so it has left the inbox. What the *run* does next
    // happens on a worker, so the record is re-read here for what is already
    // true and the tail reports the rest as it happens — rather than a reload
    // that would photograph the run a moment before it moved.
    await loadInbox();
    if (state.kind === "loaded" && state.run.runId === runId) {
      await refresh(runId);
    }
    return { ok: true };
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (runIdInput.trim() !== "") void load(runIdInput.trim());
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Forge control plane</h1>

      {inbox.kind === "loading" ? <p>Loading the approval inbox…</p> : null}
      {inbox.kind === "error" ? (
        <p role="alert" className="font-medium">
          {inbox.message}
        </p>
      ) : null}
      {inbox.kind === "loaded" ? (
        <ApprovalInbox
          approvals={inbox.approvals}
          now={clock}
          onDecide={decide}
        />
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-sm font-medium" htmlFor="run-id">
            Run id
          </label>
          <input
            id="run-id"
            className="mt-1 rounded border p-2 font-mono text-sm"
            value={runIdInput}
            onChange={(event) => setRunIdInput(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className="rounded border px-3 py-2 text-sm font-medium"
        >
          Open run
        </button>
      </form>

      {state.kind === "loading" ? <p>Loading run…</p> : null}
      {state.kind === "error" ? (
        <p role="alert" className="font-medium">
          {state.message}
        </p>
      ) : null}

      {state.kind === "loaded" ? (
        <RunInspector
          run={state.run}
          approvals={state.approvals}
          events={state.events}
          now={clock}
        />
      ) : null}

      <LocalStatus dependencies={dependencies} />
    </main>
  );
}
