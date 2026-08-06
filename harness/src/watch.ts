import { call } from "./api.js";
import { sleep } from "./docker.js";
import type { Api } from "./processes.js";

/**
 * One poller for the whole fleet.
 *
 * Polling each run individually would put `runs / interval` requests per second
 * onto the control plane being measured, so the instrument would dominate the
 * measurement. One `GET /v1/runs` every `intervalMs` costs a fixed, known rate
 * and quantises every observation upward by up to one interval.
 *
 * That bias is not corrected for. It is stated in `LOAD.md`, because a
 * correction would be a model of the sampling error rather than a measurement
 * of it, and a latency number nobody can reproduce from the raw data is worse
 * than a slightly pessimistic one.
 */
export class StatusWatch {
  private readonly first = new Map<string, Map<string, number>>();
  private stopped = false;
  private readonly loop: Promise<void>;
  private failure: unknown;

  constructor(
    private readonly api: Api,
    private readonly intervalMs = 20,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const listed = await call(
          this.api,
          "GET",
          "/v1/runs",
          "marketing-lead",
        );
        const at = performance.now();
        for (const run of (listed.body.runs ?? []) as {
          runId: string;
          status: string;
        }[]) {
          const seen = this.first.get(run.status) ?? new Map<string, number>();
          if (!seen.has(run.runId)) seen.set(run.runId, at);
          this.first.set(run.status, seen);
        }
      } catch (error) {
        // A poll that fails while the scenario is deliberately killing things
        // is expected. One that fails for another reason is surfaced by
        // `check()` rather than swallowed.
        this.failure = error;
      }
      await sleep(this.intervalMs);
    }
  }

  /** When this run was first *observed* in that status. */
  at(runId: string, status: string): number | undefined {
    return this.first.get(status)?.get(runId);
  }

  seen(status: string): ReadonlySet<string> {
    return new Set(this.first.get(status)?.keys() ?? []);
  }

  countIn(status: string, of: ReadonlySet<string>): number {
    let total = 0;
    for (const runId of this.first.get(status)?.keys() ?? []) {
      if (of.has(runId)) total += 1;
    }
    return total;
  }

  lastFailure(): unknown {
    return this.failure;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
