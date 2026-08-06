import { Readable } from "node:stream";

import { type ControlPlaneStack, compileToArtifact } from "@forge/composition";
import {
  acceptDelivery,
  type Connector,
  type IntakeLedgerPort,
} from "@forge/intake";
import {
  type ApprovalDecision,
  type JsonValue,
  RUN_STORE_ERRORS,
  RUNTIME_ERRORS,
  type RunStatus,
} from "@forge/ports";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { mayDecide, type Principal } from "./identity.js";

/**
 * Control-plane routes.
 *
 * The API is the boundary that establishes who is acting. A decision's
 * principal is taken from the authenticated caller, never from the request
 * body — a body field is not an identity claim (006 §2).
 *
 * **One stack per deployment.** This file used to build a fresh stack for any
 * request that carried a `policy`, which with the durable root would have meant
 * a new Postgres pool and a new Redis connection per run started. Policy now
 * resolves from the company package the process loaded at boot, so there is one
 * runtime, one approval store and one run store to ask — and a run this process
 * did not start is an ordinary run rather than a 404.
 */

interface StartBody {
  readonly workflow?: unknown;
  /**
   * What the run's roles require. Not authority: the evaluator checks each
   * against the policy closure's grants, so naming a capability the company was
   * never granted denies the action rather than conferring it.
   */
  readonly capabilities?: readonly string[];
  readonly changedPaths?: readonly string[];
  /** The run's input, which the workflow's input nodes produce. */
  readonly payload?: JsonValue;
}

interface DecisionBody {
  readonly decision?: "approve" | "reject" | "edit" | "timeout";
  readonly reason?: string;
  readonly patch?: unknown;
}

function toDecision(body: DecisionBody): ApprovalDecision | undefined {
  switch (body.decision) {
    case "approve":
      return { kind: "approve" };
    case "reject":
      return { kind: "reject", reason: body.reason ?? "No reason given." };
    case "edit":
      return { kind: "edit", patch: body.patch };
    case "timeout":
      return { kind: "timeout" };
    default:
      return undefined;
  }
}

const RUN_STATUSES = new Set<string>([
  "PENDING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] satisfies readonly RunStatus[]);

export interface RunRoutesOptions {
  /**
   * Resolves the acting principal — subject *and* roles — from the request, at
   * the trusted boundary. A rule's `approvers` names roles rather than people,
   * so membership is settled here and never read from the request (012 §8).
   */
  readonly authenticate: (
    request: FastifyRequest,
  ) => Promise<Principal | undefined>;
  /**
   * The one stack this deployment serves — local or durable, decided at boot.
   * The routes cannot tell which they got, which is the point: everything below
   * reads the store rather than a map of runs this process happens to remember.
   */
  readonly stack: ControlPlaneStack;
  /**
   * Intake adapters this deployment serves, by channel, and the ledger they
   * deduplicate against (015 Phase 8).
   *
   * Absent means this control plane has no webhook endpoint at all — which is
   * the right default. A channel that is not bound is a 404, not an endpoint
   * that authenticates nobody.
   */
  readonly intake?: {
    readonly connectors: Readonly<Record<string, Connector>>;
    readonly ledger: IntakeLedgerPort;
  };
}

/**
 * An event's family, from its name. An unrecognised name falls to `other` and
 * is shown raw rather than dropped: silently discarding telemetry is worse.
 */
function eventKind(name: string): RunEventView["kind"] {
  const family = name.split(".")[1];
  switch (family) {
    case "run":
      return "run";
    case "node":
      return "node";
    case "policy":
      return "policy";
    case "approval":
      return "approval";
    case "effect":
      return "effect";
    default:
      return "other";
  }
}

interface RunEventView {
  readonly seq: number;
  readonly at: string;
  readonly kind: "run" | "node" | "policy" | "approval" | "effect" | "other";
  readonly name: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/* -------------------------------------------------------------------------- */
/* Streaming the timeline                                                     */
/* -------------------------------------------------------------------------- */

const EVENT_STREAM = "text/event-stream";

/**
 * How often an open stream asks the store what it has not yet delivered.
 *
 * The tail is a poll of the **durable** timeline, not a subscription to this
 * process's recorder, and that is deliberate. The control plane usually does
 * not walk the run — a worker does, possibly on another host — so an in-process
 * event bus would tail beautifully in the local stack and never emit a thing in
 * a real deployment: a stream that silently stops tailing is worse than no
 * stream. Postgres `LISTEN/NOTIFY` would be the push version, but it lives
 * inside one store adapter, has no in-memory counterpart, and would put the
 * two composition roots on different semantics.
 *
 * So the polling moved from every client to one place, and the wire became a
 * push. 250ms because a gate appearing within a quarter of a second is
 * indistinguishable from instant to a human, and because a control plane
 * holding a run inspector open should not be a quarter of the database's load.
 */
const TAIL_INTERVAL_MS = 250;

/**
 * Whether the caller asked for the stream rather than the snapshot.
 *
 * Content negotiation, not a second route. The snapshot and the stream are the
 * same collection in two representations — same run, same records, same order
 * — and `Accept` is the header that exists to choose between representations
 * of one resource. It also means the authentication, the 404 and the
 * classification below are literally the same lines for both: a separate
 * `/events/stream` route would have been a second copy of all three, and the
 * copy that drifts is the one nobody is looking at.
 *
 * `EventSource` sends this header on its own, so a browser needs no query
 * parameter to opt in — and anything asking for `*​/*` still gets JSON, which
 * keeps the existing route's behaviour exactly as it was.
 */
const wantsStream = (accept: string | undefined): boolean =>
  accept?.includes(EVENT_STREAM) === true;

/**
 * One SSE frame. `id:` is the store's sequence, which is what makes
 * `Last-Event-ID` on reconnect mean "everything after this record" rather than
 * "everything again" — the sequence is a fact about the row, so it survives the
 * process that wrote it.
 */
const frame = (event: RunEventView): string =>
  `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

/** Where a reconnecting client left off. Anything unparseable starts over. */
function resumeFrom(header: string | string[] | undefined): number {
  const seq = Number.parseInt(Array.isArray(header) ? "" : (header ?? ""), 10);
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

export function registerRunRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): void {
  const { stack } = options;

  /**
   * A connector's endpoint (015 Phase 8).
   *
   * Deliberately *not* behind `authenticate`. The caller is Slack, or Jira, or
   * a Buzz relay — none of them holds a Forge credential, and demanding one
   * would mean handing an operator's token to a third party. Authentication
   * here is the connector's signature check, which establishes the *sending
   * system*; it says nothing about whether the run may happen, and nothing
   * downstream treats it as if it did. Policy still decides, gates still open,
   * and the origin is recorded so an audit can say which webhook asked.
   *
   * The reply is deliberately uninformative. Everything on the other side is
   * untrusted, and telling a forged signature why it failed is telling an
   * attacker how to succeed — so `UNVERIFIED` is a bare 401, and every other
   * refusal is a 202 that promises nothing.
   */
  /**
   * What an untrusted caller is told, and how little of it.
   *
   * `UNVERIFIED` is a bare 401: telling a forged signature *why* it failed is
   * telling an attacker how to succeed. Everything else is a 202 that promises
   * nothing — a duplicate is the *correct* outcome of a redelivery, and a
   * sender that receives an error for one keeps retrying, which is the single
   * behaviour deduplication exists to stop. `UNSUPPORTED` is most of a busy
   * workspace's traffic and is not a failure either.
   */
  const refuse = (
    reply: FastifyReply,
    code: "UNVERIFIED" | "DUPLICATE" | "UNSUPPORTED" | "MALFORMED",
  ) =>
    code === "UNVERIFIED"
      ? reply.code(401).send({ status: "unauthorized" })
      : reply.code(202).send({ status: "accepted", outcome: code });

  /**
   * Registered in its own plugin scope so it can keep the raw body.
   *
   * Fastify parses a JSON body before any handler runs, and a parsed body
   * cannot be signature-checked: `JSON.parse` then `JSON.stringify` does not
   * round-trip — whitespace, number formatting, unicode escapes — so a digest
   * over a re-serialised body is a digest over something the sender never
   * signed. For a compact body the two happen to agree, which is exactly what
   * makes the mistake survive testing.
   *
   * Scoped rather than global because every other route wants its body
   * parsed, and a content-type parser registered on `app` would change all of
   * them. The connector parses this itself, after it has decided the sender
   * is real.
   */
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scoped.post<{ Params: { channel: string } }>(
      "/v1/intake/:channel",
      async (request, reply) => {
        const intake = options.intake;
        const connector = intake?.connectors[request.params.channel];
        if (intake === undefined || connector === undefined) {
          // A channel nobody bound. Not an endpoint that authenticates nobody.
          return reply.code(404).send({ status: "not_found" });
        }

        /**
         * The raw body, not a parsed one. A signature covers the bytes that were
         * sent: `JSON.parse` followed by `JSON.stringify` does not round-trip,
         * so a re-serialised body verifies against a signature the sender never
         * computed — which is to say against nothing.
         */
        const raw =
          typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body ?? {});

        const outcome = await acceptDelivery(connector, intake.ledger, {
          body: raw,
          headers: request.headers as Record<string, string>,
        });

        if (!outcome.ok) return refuse(reply, outcome.code);

        const compiled = compileToArtifact(outcome.value.workflow);
        if (!compiled.ok) {
          /**
           * The deployment's own workflow did not compile, which is a
           * deployment fault and not the sender's. 500, and the diagnostics stay
           * here: a webhook caller learns nothing about the inside.
           */
          request.log.error(
            { diagnostics: compiled.diagnostics, origin: outcome.value.origin },
            "intake workflow failed to compile",
          );
          return reply.code(500).send({ status: "error" });
        }

        const run = await stack.runtime.create({
          artifact: compiled.artifact,
          capabilities: [...outcome.value.capabilities],
          changedPaths: [...outcome.value.changedPaths],
          ...(outcome.value.payload === undefined
            ? {}
            : { payload: outcome.value.payload }),
          /**
           * Recorded on the run, because nothing downstream can reconstruct
           * it. The worker that tells this Slack thread its run reached a gate
           * never saw the delivery — and `receivedAt` is dropped, because a
           * time this process happened to observe is not a fact about the run.
           */
          origin: {
            channel: outcome.value.origin.channel,
            externalId: outcome.value.origin.externalId,
            externalActor: outcome.value.origin.externalActor,
          },
        });

        await stack.queue.enqueue({
          type: "workflow.execute",
          runId: run.runId,
          workflowVersionId: run.fingerprint,
          attempt: run.attempt,
        });

        // The run id goes back so a connector can post a link into the thread
        // it came from. It is not a promise the run succeeded — nothing has
        // walked.
        return reply.code(202).send({ status: "accepted", runId: run.runId });
      },
    );
  });

  app.post("/v1/workflows/compile", async (request, reply) => {
    // Authenticated like every sibling route. Compiling reads and writes no
    // run state, which is why this was overlooked — but it is unmetered work
    // on a control plane, and one endpoint that behaves differently from the
    // rest is the one nobody thinks about.
    if ((await options.authenticate(request)) === undefined) {
      return reply.code(401).send({ status: "unauthorized" });
    }

    const body = (request.body ?? {}) as StartBody;
    const outcome = compileToArtifact(body.workflow);
    if (!outcome.ok) {
      return reply.code(422).send({
        status: "invalid",
        code: "WORKFLOW_COMPILE_FAILED",
        diagnostics: outcome.diagnostics,
      });
    }
    return reply.send({
      status: "compiled",
      workflowId: outcome.artifact.workflowId,
      fingerprint: outcome.artifact.fingerprint,
      publicSurface: {
        approvalGates: outcome.artifact.ir.nodes
          .filter((node) => node.kind === "approval")
          .map((node) => node.id),
        declaredEffects: outcome.artifact.ir.sideEffects,
        requiredCapabilities: outcome.artifact.ir.grantedCapabilities,
        roles: Object.keys(outcome.artifact.ir.roles).sort(),
      },
    });
  });

  app.post("/v1/runs", async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    const body = (request.body ?? {}) as StartBody;
    const outcome = compileToArtifact(body.workflow);
    if (!outcome.ok) {
      return reply.code(422).send({
        status: "invalid",
        code: "WORKFLOW_COMPILE_FAILED",
        diagnostics: outcome.diagnostics,
      });
    }

    /**
     * Persist, then enqueue (006 §10.1). The control plane does not walk the
     * run: it used to call `Runtime.start`, which held this request open
     * across every policy check, sandbox lease and model call the workflow
     * reached — with a real provider bound that is minutes, not milliseconds.
     *
     * The order is load-bearing. A job for a run that is not in the store is a
     * job whose consumer cannot find it, and it would be retried until it gave
     * up; a record with no job is a run an operator can see sitting at PENDING
     * and re-drive. Only one of those two failures is visible.
     */
    const run = await stack.runtime.create({
      artifact: outcome.artifact,
      capabilities: body.capabilities ?? [],
      changedPaths: body.changedPaths ?? [],
      // Absent stays absent: an omitted payload must not become an empty one,
      // or a node reading it would proceed on data nobody sent.
      ...(body.payload === undefined ? {} : { payload: body.payload }),
    });

    await stack.queue.enqueue({
      type: "workflow.execute",
      runId: run.runId,
      // The sealed fingerprint *is* the workflow version: it is what the
      // approval's binding is recomputed against, so naming anything else here
      // would be naming a version the run is not pinned to.
      workflowVersionId: run.fingerprint,
      attempt: run.attempt,
    });

    /**
     * **202, not 201.** A run resource genuinely was created, which is the
     * case for 201 — but the reply's body is a run at `PENDING`, and the thing
     * the caller asked for has not happened yet. 202 is the code that says so
     * at the wire, and it is also the visible break for anyone whose client
     * read the old 201 body as the outcome of the run. `Location` answers the
     * usual objection to 202, that it leaves a caller with nowhere to look:
     * the run is addressable from the moment this returns.
     */
    return reply
      .code(202)
      .header("location", `/v1/runs/${run.runId}`)
      .send(run);
  });

  app.get<{ Querystring: { status?: string } }>(
    "/v1/runs",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      const { status } = request.query;
      if (status !== undefined && !RUN_STATUSES.has(status)) {
        // Refused rather than ignored. A misspelt status that quietly listed
        // everything would show an operator runs they asked to exclude.
        return reply.code(422).send({
          status: "invalid",
          code: "RUN_STATUS_UNKNOWN",
          message: `status must be one of ${[...RUN_STATUSES].join(", ")}.`,
        });
      }

      // From the store, most recent first — an operator is looking for what
      // just happened. Read from the store rather than from a map of runs this
      // process started, because after a restart that map is empty while every
      // one of those runs is still in Postgres.
      const runs = await stack.runs.list(
        status === undefined ? {} : { status: status as RunStatus },
      );
      return reply.send({ runs });
    },
  );

  /**
   * The operator inbox. Scoped by the port to gates this principal may decide,
   * so widening the query cannot widen who sees what.
   */
  app.get("/v1/approvals", async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    const pending = await stack.approvals.listPendingFor(
      principal.subject,
      principal.roles,
    );
    // Closest to expiry first: an expired gate times out, it is not a slow yes.
    return reply.send({
      pending: [...pending].sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt),
      ),
    });
  });

  /** What an operator gets without asking, and the most they can ask for. */
  const DEFAULT_UNSETTLED = 100;
  const MAX_UNSETTLED = 1_000;

  /**
   * Actions this deployment claimed and was never seen to finish.
   *
   * The claim is written before the action, deliberately: losing an effect is
   * recoverable and repeating one is not. "Recoverable" only means anything if
   * somebody is told, and nothing told anybody — the run carried on, the
   * ledger said the node had dispatched, and an action a human approved simply
   * never happened.
   *
   * Deliberately a report and nothing more. There is no redrive button here,
   * because nobody can tell from this record whether the action failed to
   * happen or happened and the process died before it could say so. Re-running
   * it is a decision to perform a side effect under that uncertainty, which is
   * the one thing in this system that requires a human bound to the exact
   * action — so it goes through a gate like everything else, not through an
   * operator endpoint that quietly re-sends.
   *
   * Estate-wide and not per-run, because nobody knows which run to go and look
   * at. Authenticated for the same reason `GET /v1/runs/:runId` is: it names
   * effects and the runs they belong to.
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/v1/effects/unsettled",
    async (request, reply) => {
      if ((await options.authenticate(request)) === undefined) {
        return reply.code(401).send({ status: "unauthorized" });
      }

      /**
       * Bounded, and the bound is visible in the response.
       *
       * The day this list is long is the day an outage made it long — the one
       * day an operator most needs the page to load, and the one day an
       * unbounded query is slowest. `truncated` is there because a page that
       * silently stops at a hundred reads as "a hundred outstanding", and the
       * difference between that and "at least a hundred" is the difference
       * between a bad morning and an incident.
       */
      const requested = Number.parseInt(request.query.limit ?? "", 10);
      if (request.query.limit !== undefined && !Number.isInteger(requested)) {
        return reply
          .code(400)
          .send({ status: "bad_request", code: "LIMIT_NOT_A_NUMBER" });
      }
      const limit = Math.min(
        Math.max(
          Number.isInteger(requested) ? requested : DEFAULT_UNSETTLED,
          0,
        ),
        MAX_UNSETTLED,
      );

      // One more than asked for, so "there are others" is a fact rather than
      // an inference from a full page.
      const found = await stack.runs.listUnsettled(limit + 1);
      return reply.send({
        unsettled: found.slice(0, limit),
        limit,
        truncated: found.length > limit,
      });
    },
  );

  /**
   * Ask for an action nobody can account for to be performed again.
   *
   * Opens a gate; it does not pass through one. The response is the run
   * waiting on a new approval, and the action happens only when a human who
   * may decide it does — through the ordinary decision route, checked the
   * ordinary way. A redrive that acted here would be an operator endpoint that
   * performs a side effect on a caller's say-so, which is the exact shape this
   * system exists to make impossible.
   *
   * 409 rather than 400 on a refusal: nothing is wrong with the request, the
   * run is in a state where this is not a recovery — the action already
   * completed, or was never claimed, or the run is already at a gate.
   */
  app.post<{ Params: { runId: string; nodeId: string } }>(
    "/v1/runs/:runId/effects/:nodeId/redrive",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      try {
        const run = await stack.runtime.redrive(
          request.params.runId,
          request.params.nodeId,
        );
        return reply.code(202).send(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Unknown run")) {
          return reply.code(404).send({ status: "not_found" });
        }
        /**
         * Both sets come from `@forge/ports`, store's and runtime's alike.
         * Three packages agree on these strings, and spelling them here meant
         * a rename on either side turned a 409 into an unhandled 500 rather
         * than failing to compile.
         */
        const code = [
          RUN_STORE_ERRORS.effectSettled,
          RUN_STORE_ERRORS.effectNotClaimed,
          RUNTIME_ERRORS.awaitingApproval,
          RUNTIME_ERRORS.notRedrivable,
        ].find((known) => message.startsWith(known));
        if (code === undefined) throw error;
        return reply.code(409).send({ status: "conflict", code, message });
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId",
    async (request, reply) => {
      // A run record names the effects that actually fired. Its two sibling
      // routes check; this one did not, so the whole record was readable
      // unauthenticated. Checked before the lookup, so an anonymous caller
      // cannot tell a missing run from one they may not see.
      if ((await options.authenticate(request)) === undefined) {
        return reply.code(401).send({ status: "unauthorized" });
      }

      const run = await stack.runtime.loadRun(request.params.runId);
      if (run === undefined)
        return reply.code(404).send({ status: "not_found" });
      return reply.send(run);
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId/approvals",
    async (request, reply) => {
      // Authenticated because the reply names who decided each gate.
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      if ((await stack.runtime.loadRun(request.params.runId)) === undefined)
        return reply.code(404).send({ status: "not_found" });
      return reply.send({
        pending: await stack.approvals.getPending(request.params.runId),
        approvals: await stack.approvals.listByRun(request.params.runId),
      });
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId/events",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      if ((await stack.runtime.loadRun(request.params.runId)) === undefined)
        return reply.code(404).send({ status: "not_found" });

      // The run's durable timeline, not this process's. A run started before
      // a restart, or in another control plane, reads the same as one started
      // here — which `stack.timeline()` could never do.
      //
      // Ordered by the store's sequence, so two events in the same millisecond
      // cannot tie and swap between reads. Attributes were redacted before the
      // row was written, which is what makes them safe to serve.
      const timeline = async (): Promise<RunEventView[]> =>
        (await stack.runEvents.list(request.params.runId)).map((entry) => ({
          seq: entry.seq,
          at: entry.at,
          kind: eventKind(entry.name),
          name: entry.name,
          attributes: entry.attributes,
        }));

      if (!wantsStream(request.headers.accept)) {
        return reply.send({ events: await timeline() });
      }

      const stream = new Readable({ read() {} });
      let open = true;
      // The socket, not the reply. This is what fires when the operator closes
      // the tab, and it is the only thing that stops the loop below — a stream
      // whose reader has gone away and whose poll has not is a leak per tab.
      request.raw.on("close", () => {
        open = false;
      });

      let cursor = resumeFrom(request.headers["last-event-id"]);

      void (async () => {
        try {
          while (open) {
            /**
             * Re-authenticated every pass, which the snapshot never had to
             * think about because it answered and was gone. A stream outlives
             * the credential that opened it: a session revoked, signed out or
             * expired an hour ago would otherwise keep delivering a run's
             * timeline to whoever still held the socket. The check is the same
             * one the route opened with — nothing here is a second, weaker
             * copy of it.
             */
            if ((await options.authenticate(request)) === undefined) break;
            for (const event of await timeline()) {
              if (event.seq <= cursor) continue;
              cursor = event.seq;
              stream.push(frame(event));
            }
            await new Promise((settle) => setTimeout(settle, TAIL_INTERVAL_MS));
          }
        } catch {
          // Telemetry fails open, and a timeline is telemetry. A store that
          // went away ends this stream and nothing else: no run is walking on
          // this stack, and the operator's next read is a fresh connection.
        }
        stream.push(null);
      })();

      return (
        reply
          .header("content-type", EVENT_STREAM)
          // An intermediary that buffered this would turn a tail into a snapshot
          // delivered late, which looks exactly like a stream that does not work.
          .header("cache-control", "no-store")
          .header("x-accel-buffering", "no")
          .send(stream)
      );
    },
  );

  app.post<{ Params: { runId: string; approvalId: string } }>(
    "/v1/runs/:runId/approvals/:approvalId/decision",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      const body = (request.body ?? {}) as DecisionBody;

      const decision = toDecision(body);
      if (decision === undefined) {
        return reply.code(422).send({
          status: "invalid",
          code: "DECISION_INVALID",
          message: "decision must be approve, reject, edit or timeout.",
        });
      }

      /**
       * Authority, checked here because the runtime cannot: it is handed a
       * principal and has no directory to ask whether that principal is one of
       * the gate's approvers (006 §6.4 step 6). Without this the inbox was
       * merely a filtered view — anyone authenticated could decide any gate by
       * naming its id, which is not a boundary.
       */
      const approval = await stack.approvals.get(request.params.approvalId);
      // The run in the path must be the run the gate belongs to. Without this
      // the path parameter is decorative: a caller sending the right approval
      // with the wrong run gets a 200 and a decision applied to a run they did
      // not name. Not a bypass — the binding and the approver check still hold
      // — but "a decision bound to one exact action" cannot also mean "and any
      // run you like".
      if (approval !== undefined && approval.runId !== request.params.runId) {
        return reply.code(404).send({ status: "not_found" });
      }
      if (approval !== undefined && !mayDecide(principal, approval.approvers)) {
        return reply.code(403).send({
          status: "forbidden",
          code: "DECISION_FORBIDDEN",
          message: `This gate is decided by ${approval.approvers.join(", ")}.`,
        });
      }

      try {
        /**
         * Mark the decision durably, enqueue the resume, reply (006 §10.3).
         *
         * The same shape as `POST /v1/runs`, and for the same reason: this
         * route used to walk the graph inside the request, which held it open
         * across every node after the gate — the sandbox lease, the model
         * call, the dispatch itself. An operator's click is not the place to
         * discover that a downstream agent takes four minutes.
         *
         * `recordDecision` runs the gate's own checks — bound, unexpired,
         * still pending — and stops. It does not advance the run, so an
         * approve leaves the record exactly where it parked, and the walk
         * happens on whichever process consumes the job. That process calls
         * `resume`, which re-checks the binding and the deadline where the
         * dispatch is actually authorised.
         *
         * Order, as on the start route: a job for a decision that is not
         * durable would authorise nothing when it arrived, whereas a decision
         * with no job is a run an operator can see and re-drive.
         */
        const run = await stack.runtime.recordDecision(
          request.params.approvalId,
          decision,
          principal.subject,
        );

        // Every decision, not only an approve. Whether a decision advances a
        // run is the runtime's to know: a route that enqueued for `approve`
        // alone would be a second, quietly diverging copy of that rule, and
        // `resume` is total — a rejected run is terminal and it does nothing.
        // The operation key is `resume:<run>:<approval>`, so a redelivered or
        // repeated decision is one resume.
        await stack.queue.enqueue({
          type: "workflow.resume",
          runId: request.params.runId,
          approvalId: request.params.approvalId,
          attempt: run.attempt,
        });

        /**
         * **202, not 200.** The decision is recorded — that part is done and
         * durable — but what the operator asked for, the effect reaching the
         * outside world, has not happened yet. A 200 carrying a run still at
         * `AWAITING_APPROVAL` would read as a failure to anyone who had been
         * getting `SUCCEEDED` here, and that is precisely who needs to notice.
         * `Location` says where the answer will appear.
         */
        return reply
          .code(202)
          .header("location", `/v1/runs/${request.params.runId}`)
          .send(run);
      } catch (error) {
        return reply.code(409).send({
          status: "conflict",
          code: "DECISION_REFUSED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
