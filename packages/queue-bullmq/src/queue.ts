import { type ForgeJob, operationKey, type QueuePort } from "@forge/ports";
import { Queue, Worker } from "bullmq";

/** Long enough that a restarting Redis is listening again. */
const RECONNECT_DELAY_MS = 1_000;
/** Short enough that a readiness probe answers rather than hangs. */
const HEALTH_TIMEOUT_MS = 2_000;
/**
 * How long a graceful shutdown is given before the connections are torn down
 * underneath it. Well inside a typical orchestrator's termination grace period,
 * because the alternative to returning is being SIGKILLed.
 */
const CLOSE_TIMEOUT_MS = 5_000;

import { Redis } from "ioredis";

import { parseForgeJob } from "./job-schema.js";

/**
 * `QueuePort` over BullMQ and Redis (ADR-004). Transport and worker
 * scheduling — not the workflow engine. No BullMQ or ioredis type crosses this
 * module's boundary, and the connection URL is supplied by the composition
 * root, which is the only place that reads it from the environment. This
 * package never names a host or a credential.
 */

export interface BullMqQueueOptions {
  /** Redis connection URL. Read from the environment by the caller. */
  readonly url: string;
  /** Queue name. Two names on one Redis are two independent queues. */
  readonly name: string;
  /** Key namespace, so Forge's keys are recognisable in a shared Redis. */
  readonly prefix?: string;
}

/**
 * BullMQ reserves `:` inside its own key structure and rejects a custom job id
 * that contains one, so the operation key is punctuated differently for the
 * job id. The key the caller sees, and the key idempotency is decided on, is
 * still `operationKey()` verbatim.
 */
const jobIdFor = (key: string): string => key.replaceAll(":", "|");

export function createBullMqQueue(options: BullMqQueueOptions): QueuePort {
  const prefix = options.prefix ?? "forge";
  // A blocking worker connection must not give up on a command, and BullMQ
  // refuses to start one that would. Producer and consumer get their own
  // connections so a blocked consumer cannot stall an enqueue.
  const connectionOptions = { maxRetriesPerRequest: null } as const;
  const clients: Redis[] = [];

  /**
   * A client with no error listener takes the process down when Redis hangs
   * up, which is what a restart or a stopped container looks like. Redis going
   * away is a health result, reported by `health()`, not a crash.
   */
  function connect(): Redis {
    const client = new Redis(options.url, connectionOptions);
    client.on("error", () => {});
    clients.push(client);
    return client;
  }

  const producer = connect();
  const queue = new Queue(options.name, { connection: producer, prefix });
  let worker: Worker | undefined;
  /** Whether this process's consumer is actually attached to Redis. */
  let consuming = false;
  let closed = false;
  let attach: (() => Worker) | undefined;

  /**
   * BullMQ emits `ioredis:close` when it has *given up* reconnecting, so the
   * worker is not coming back on its own. Left alone, the process stays up,
   * answers health checks and consumes nothing — a Redis blip becomes a
   * permanently stalled queue with a green probe on it. Recreating the worker
   * is what makes an outage a pause rather than an ending.
   */
  function wire(instance: Worker): void {
    instance.on("error", () => {});
    instance.on("ready", () => {
      consuming = true;
    });
    instance.on("ioredis:close", () => {
      consuming = false;
      if (closed || attach === undefined) return;
      void instance.close(true).catch(() => undefined);
      setTimeout(() => {
        if (closed || attach === undefined) return;
        worker = attach();
        wire(worker);
      }, RECONNECT_DELAY_MS).unref();
    });
  }

  /**
   * The idempotency ledger, in Redis rather than in this process: two workers
   * each holding their own `Set` would each act once, which is twice. The key
   * is claimed before the handler runs, matching the port's contract — at most
   * once to the handler — so a redelivery after a crash is dropped rather than
   * replayed. Deliberately without a TTL: an operation key that expired would
   * make a late redelivery act a second time, and "eventually acts twice" is
   * not idempotency.
   */
  async function claim(key: string): Promise<boolean> {
    return (
      (await producer.set(`${prefix}:${options.name}:op:${key}`, "1", "NX")) ===
      "OK"
    );
  }

  return {
    async enqueue(job, options) {
      const key = operationKey(job);
      // Completed jobs are retained on purpose: the job record is the second
      // line of dedup, and removing it would free the id for a repeat.
      await queue.add(job.type, job, {
        jobId: jobIdFor(key),
        // BullMQ's own delayed set holds it, so the wait survives this
        // process exiting — which is the point of deferring in a queue rather
        // than in a timer.
        ...(options?.delayMs === undefined ? {} : { delay: options.delayMs }),
        removeOnComplete: false,
        removeOnFail: false,
      });
      return key;
    },

    async subscribe(handler) {
      if (worker !== undefined) {
        throw new Error("FORGE_QUEUE_ALREADY_SUBSCRIBED");
      }
      attach = () => {
        const connection = connect();
        const created = new Worker(
          options.name,
          async (job) => {
            const parsed: ForgeJob = parseForgeJob(job.data);
            if (!(await claim(operationKey(parsed)))) return;
            await handler(parsed);
          },
          { connection, prefix },
        );
        return created;
      };
      worker = attach();
      // Redis hanging up during shutdown is not a test result, and an
      // unhandled 'error' event would take the process with it. Swallowing it
      // is right; swallowing it and forgetting is what left a worker alive and
      // consuming nothing after an outage — the blocking connection died, the
      // listener absorbed the error, and no probe could tell.
      wire(worker);
      await worker.waitUntilReady();
      consuming = true;
    },

    async depth() {
      // Waiting for a subscriber, not in flight: a job being handled has
      // already left the queue, exactly as the memory adapter reports it.
      const [waiting, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getDelayedCount(),
      ]);
      return waiting + delayed;
    },

    async health() {
      // Two questions, not one. A reachable Redis says nothing about whether
      // *this* process is still taking jobs off it, and a worker that answers
      // ready while its consumer is detached is the failure an orchestrator
      // cannot see.
      //
      // Bounded, because the producer runs with `maxRetriesPerRequest: null`
      // so that an enqueue survives a blip — which means a command issued
      // while Redis is gone *buffers* rather than rejecting. An unbounded ping
      // turns the readiness probe into a hang, and a load balancer reading a
      // timeout instead of a 503 is worse off than one reading nothing.
      try {
        const pong = await Promise.race([
          producer.ping(),
          new Promise<"TIMEOUT">((settle) =>
            setTimeout(() => settle("TIMEOUT"), HEALTH_TIMEOUT_MS).unref(),
          ),
        ]);
        if (pong !== "PONG") return { available: false };
      } catch {
        return { available: false };
      }
      /**
       * NOT INDEPENDENTLY PROVEN, and said out loud rather than covered over.
       *
       * The `consuming` term is here because a reachable Redis says nothing
       * about whether *this* process is still taking jobs off it. It is also
       * the one term no test in this repository can currently falsify: every
       * state that detaches the consumer also breaks the ping above, so
       * `available: true` hard-coded passes the whole suite. A unit test for
       * it was written, reviewed by breaking this line, found to pass anyway,
       * and deleted — a check that cannot fail is worse than none, because it
       * is the reason nobody asks again.
       *
       * What *is* proven, by harness/test/chaos.scenario.ts, is the behaviour
       * this reports on: after Redis goes and returns, the worker reattaches
       * and the run finishes. Falsifying the report itself needs a live Redis
       * with a dead consumer, which nothing here can construct.
       */
      return { available: worker === undefined || consuming };
    },

    async close() {
      closed = true;
      consuming = false;

      /**
       * Bounded, for the same reason `health()` is, and with worse
       * consequences if it is not.
       *
       * A graceful close is a conversation with Redis: BullMQ waits for the
       * worker to finish, and `quit()` waits for the server to acknowledge.
       * When Redis is gone there is nobody to answer, so every step of that
       * waits forever. The process that calls this on SIGTERM then never
       * reaches its own exit — it hangs until the orchestrator SIGKILLs it,
       * which drops the buffered telemetry describing why Redis went away in
       * the first place. Shutting down during an outage is precisely when a
       * clean shutdown is worth most.
       *
       * `disconnect()` needs no server, so it always finishes the job.
       */
      await Promise.race([
        (async () => {
          await worker?.close();
          await queue.close();
          await Promise.all(clients.map((client) => client.quit()));
        })().catch(() => undefined),
        new Promise<void>((settle) =>
          setTimeout(settle, CLOSE_TIMEOUT_MS).unref(),
        ),
      ]);
      for (const client of clients) client.disconnect();
    },
  };
}
