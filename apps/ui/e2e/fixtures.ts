import { type RunStatus, TERMINAL_RUN_STATUSES } from "@forge/ports";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

import {
  OPERATOR_ROLE,
  OPERATOR_SUBJECT,
  type RunningApi,
  type RunningProcess,
  startApi,
  startUi,
} from "./processes.js";

/**
 * What every browser test is given: a running control plane, a running UI, and
 * the two things a test has to do outside the browser — open a real gate, and
 * ask the control plane afterwards what actually happened.
 *
 * The second half is the point. A browser assertion can only show what the
 * screen said; whether the effect *dispatched* is a fact about the run record,
 * and a suite that never reads it is testing a screen rather than a control
 * plane.
 */

/**
 * The smallest workflow that reaches a gate and then causes something.
 *
 * Deliberately no judge and no branch: the API refuses a body carrying votes or
 * a branch arm — naming either would steer the very decision a human is being
 * asked to make — and the deployment binds no review adapter, so a judge here
 * would fail closed before the gate.
 */
const WORKFLOW = {
  id: "acme.marketing.ui-acceptance",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  grantedCapabilities: ["repo.read", "docs.write", "slack.write"],
  roles: {
    "marketing-writer": {
      version: "1.0.0",
      capabilities: { requires: ["slack.write"], forbids: ["repo.merge"] },
    },
  },
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.campaign.input@1" },
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "acme.campaign.gate@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "slack.post@1",
      effect: "slack.post",
      role: "marketing-writer",
    },
    { id: "result", kind: "output", schemaRef: "acme.campaign.output@1" },
  ],
  edges: [
    { from: "intake", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
} as const;

export interface Gate {
  readonly runId: string;
  readonly approvalId: string;
  /** The binding the control plane computed for this run, not a fixture's. */
  readonly effectHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface RunRecord {
  readonly runId: string;
  readonly status: string;
  readonly performedEffects: readonly string[];
  readonly error?: string;
}

interface ApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly effectHash: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedBy?: string;
  readonly reason?: string;
}

export interface Forge {
  /**
   * Starts a run and waits for it to reach its gate. The gate is real: Acme's
   * policy pack required a human for `slack.post`, so nothing dispatches until
   * one answers.
   */
  openGate(): Promise<Gate>;
  run(runId: string): Promise<RunRecord>;
  /**
   * The run once the queue owes it nothing. A decision no longer walks the
   * graph inside the request that carried it, so the effect a click authorised
   * lands a moment after the click — asserting on the record straight away
   * would be asserting on a run that had not finished moving.
   */
  settled(runId: string): Promise<RunRecord>;
  approval(runId: string, approvalId: string): Promise<ApprovalRecord>;
  /**
   * Signs in through the form, as an operator does — no cookie is injected and
   * no token is planted, so the session under test is one the API issued.
   */
  signIn(page: Page, options?: { readonly credential?: string }): Promise<void>;
  /** The inbox, located by role and accessible name rather than by structure. */
  inbox(page: Page): Locator;
  /** The one card in the inbox that belongs to this gate. */
  card(page: Page, gate: Gate): Locator;
  readonly uiUrl: string;
  readonly subject: string;
  readonly role: string;
}

interface Stack {
  readonly api: RunningApi;
  readonly ui: RunningProcess;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, ms));

/** Where a run stops. Not `AWAITING_APPROVAL`: that is a run still waiting. */
/**
 * The browser's view of "finished", which is genuinely terminal rather than
 * merely stopped: a run at a gate is exactly what these tests wait *at*.
 */
const TERMINAL: ReadonlySet<string> = TERMINAL_RUN_STATUSES;

export const test = base.extend<{ forge: Forge }, { stack: Stack }>({
  stack: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this destructuring pattern, and this one depends on nothing.
    async ({}, use) => {
      const api = await startApi();
      const ui = await startUi(api.baseUrl);
      await use({ api, ui });
      await ui.stop();
      await api.stop();
    },
    { scope: "worker" },
  ],

  forge: async ({ stack }, use) => {
    const opened: Gate[] = [];

    async function call<Value>(
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ): Promise<Value> {
      const response = await fetch(`${stack.api.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${stack.api.credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${path} → ${response.status}: ${text}`);
      }
      return JSON.parse(text) as Value;
    }

    const approvalsOf = (runId: string) =>
      call<{ pending: ApprovalRecord[]; approvals: ApprovalRecord[] }>(
        "GET",
        `/v1/runs/${runId}/approvals`,
      );

    const forge: Forge = {
      uiUrl: stack.ui.baseUrl,
      subject: OPERATOR_SUBJECT,
      role: OPERATOR_ROLE,

      async openGate() {
        const started = await call<RunRecord>("POST", "/v1/runs", {
          workflow: WORKFLOW,
          capabilities: ["docs.write", "slack.write"],
          payload: { brief: "spring campaign" },
        });

        // The run does not execute inside the request that started it, so wait
        // for it to reach the gate rather than assuming it already has.
        const deadline = Date.now() + 30_000;
        for (;;) {
          const { pending } = await approvalsOf(started.runId);
          const gate = pending[0];
          if (gate !== undefined) {
            const opened_ = {
              runId: started.runId,
              approvalId: gate.approvalId,
              effectHash: gate.effectHash,
              createdAt: gate.createdAt,
              expiresAt: gate.expiresAt,
            };
            opened.push(opened_);
            return opened_;
          }
          if (Date.now() >= deadline) {
            const record = await call<RunRecord>(
              "GET",
              `/v1/runs/${started.runId}`,
            );
            throw new Error(
              `Run ${started.runId} never reached a gate; it is ${record.status}${
                record.error === undefined ? "" : `: ${record.error}`
              }`,
            );
          }
          await sleep(50);
        }
      },

      run: (runId) => call<RunRecord>("GET", `/v1/runs/${runId}`),

      async settled(runId) {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const record = await call<RunRecord>("GET", `/v1/runs/${runId}`);
          if (TERMINAL.has(record.status as RunStatus)) return record;
          if (Date.now() >= deadline) {
            throw new Error(
              `Run ${runId} was still ${record.status} after 30s; the decision never took effect.`,
            );
          }
          await sleep(50);
        }
      },

      async approval(runId, approvalId) {
        const { approvals } = await approvalsOf(runId);
        const found = approvals.find(
          (entry) => entry.approvalId === approvalId,
        );
        if (found === undefined) {
          throw new Error(`No approval ${approvalId} on run ${runId}.`);
        }
        return found;
      },

      async signIn(page, options = {}) {
        await page
          .getByLabel("Operator credential")
          .fill(options.credential ?? stack.api.credential);
        await page.getByRole("button", { name: "Sign in" }).click();
      },

      inbox: (page) => page.getByRole("region", { name: "Approval inbox" }),

      card: (page, gate) =>
        forge.inbox(page).getByRole("article").filter({ hasText: gate.runId }),
    };

    await use(forge);

    // Leave the inbox as it was found. A gate this test opened and did not
    // decide would otherwise still be waiting when the next test reads the
    // inbox, and an inbox with a stranger in it is one where "the second card"
    // means something different from run to run.
    for (const gate of opened) {
      const { pending } = await approvalsOf(gate.runId);
      if (pending.length === 0) continue;
      await call(
        "POST",
        `/v1/runs/${gate.runId}/approvals/${gate.approvalId}/decision`,
        { decision: "reject", reason: "Cleaning up after a browser test." },
      );
    }
  },
});

/**
 * Open the UI with the browser's clock set inside the gate's own window.
 *
 * The gate's expiry is the control plane's and the countdown is the browser's,
 * so the two clocks have to agree for a pending gate to look pending. The time
 * is taken from the gate the API just issued rather than from a literal, so
 * this keeps working whatever clock the deployment runs.
 *
 * It is needed at all because the in-memory stack `apps/api` builds without
 * Postgres starts its clock at a fixed `2026-01-01` and never advances it, so
 * every gate it issues is already expired against a browser's real clock. That
 * is a defect in the composition root, not in the UI, and it is not this
 * suite's to fix — but a suite that silently ran outside the gate's window
 * would be proving nothing about approval at all.
 */
export async function openUi(
  page: Page,
  forge: Forge,
  gate: Gate,
): Promise<void> {
  await page.clock.setFixedTime(new Date(Date.parse(gate.createdAt) + 60_000));
  await page.goto(forge.uiUrl);
  await expect(page.getByLabel("Operator credential")).toBeVisible();
}

export { expect } from "@playwright/test";
