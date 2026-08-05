import type {
  ApprovalView,
  ForgeClient,
  RunEventView,
  RunView,
} from "@forge/sdk";
import { type FormEvent, useCallback, useEffect, useState } from "react";

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

    setState({
      kind: "loaded",
      run: run.value,
      approvals: approvals.value,
      events: events.value,
    });
  };

  const decide = async (
    runId: string,
    approvalId: string,
    decision: Parameters<ForgeClient["decide"]>[2],
  ): Promise<DecisionOutcome> => {
    const result = await client.decide(runId, approvalId, decision);
    if (!result.ok)
      return { ok: false, message: `${result.code}: ${result.message}` };

    // The queue, the gate list and the effect ledger have all moved. Re-read
    // rather than patch local state, so the screen reflects the control plane
    // and not a guess about what the decision did.
    await loadInbox();
    if (state.kind === "loaded" && state.run.runId === runId) await load(runId);
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
