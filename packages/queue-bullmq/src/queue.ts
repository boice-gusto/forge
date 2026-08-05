import { type ForgeJob, operationKey, type QueuePort } from "@forge/ports";
import { Queue, Worker } from "bullmq";
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
    async enqueue(job) {
      const key = operationKey(job);
      // Completed jobs are retained on purpose: the job record is the second
      // line of dedup, and removing it would free the id for a repeat.
      await queue.add(job.type, job, {
        jobId: jobIdFor(key),
        removeOnComplete: false,
        removeOnFail: false,
      });
      return key;
    },

    async subscribe(handler) {
      if (worker !== undefined) {
        throw new Error("FORGE_QUEUE_ALREADY_SUBSCRIBED");
      }
      const connection = connect();

      worker = new Worker(
        options.name,
        async (job) => {
          const parsed: ForgeJob = parseForgeJob(job.data);
          if (!(await claim(operationKey(parsed)))) return;
          await handler(parsed);
        },
        { connection, prefix },
      );
      // Redis hanging up during shutdown is not a test result, and an
      // unhandled 'error' event would take the process with it.
      worker.on("error", () => {});
      await worker.waitUntilReady();
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
      try {
        return { available: (await producer.ping()) === "PONG" };
      } catch {
        return { available: false };
      }
    },

    async close() {
      await worker?.close();
      await queue.close();
      await Promise.all(clients.map((client) => client.quit()));
    },
  };
}
