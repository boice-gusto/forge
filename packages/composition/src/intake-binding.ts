import {
  bindConnectors,
  type Connector,
  createMemoryIntakeLedger,
  type IntakeLedgerPort,
} from "@forge/intake";
import { createPostgresIntakeLedger } from "@forge/intake-postgres";
import type { Pool } from "pg";

/**
 * Turning a company's `connectors` adapter into bound channels, for whichever
 * binary is asking.
 *
 * Here rather than in either binary, because they must not disagree — and a
 * copy in each is the way two things that must agree stop agreeing. They
 * already share policy, for the reason the worker states: a run whose outcome
 * depends on which process took it off the queue is the least debuggable
 * failure this system can have. Which channels exist is the same kind of fact
 * — an API serving a channel the worker cannot announce back to is a run
 * nobody hears about.
 */

/** Read from the process environment, never from the company package. */
export const environmentSecret = (name: string): string | undefined =>
  process.env[name];

export interface BoundIntake {
  readonly connectors: Readonly<Record<string, Connector>>;
  readonly ledger: IntakeLedgerPort;
}

/**
 * Resolves the channels, or hands the reasons to a caller who will refuse.
 *
 * `onProblems` rather than `process.exit` here: a library function that exits
 * the process cannot be composed and cannot be tested, and the decision to
 * stop belongs to the binary anyway. Both binaries do stop — a control plane
 * that started with half its channels would answer 404 on a webhook somebody
 * configured, and a worker that started with none would walk runs it could
 * never report on. Both failures look like the third party's fault.
 */
export function bindIntake(
  bound: unknown,
  pool: Pool | undefined,
  onProblems: (problems: readonly string[]) => never,
): BoundIntake | undefined {
  if (bound === undefined) return undefined;

  const result = bindConnectors(bound, environmentSecret);
  if (result.problems.length > 0) onProblems(result.problems);

  /**
   * The durable ledger when there is a database, and the in-process one only
   * when there is not.
   *
   * This is the difference between deduplicating and appearing to: two control
   * planes each holding their own `Set` each accept the same webhook retry
   * once, which is twice, which is one customer-visible workflow running
   * again.
   */
  return {
    connectors: result.connectors,
    ledger:
      pool === undefined
        ? createMemoryIntakeLedger()
        : createPostgresIntakeLedger(pool),
  };
}
