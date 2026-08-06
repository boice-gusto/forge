import { type DeploymentPolicy, loadDeploymentPolicy } from "@forge/company";
import type { JsonValue } from "@forge/ports";
import type { EffectSink, TransformFn } from "@forge/runtime";

import { PUBLISHED, SLOW_TRANSFORM } from "./workflows.js";

/**
 * The observable half of a harness process.
 *
 * `apps/worker` binds a sink that performs nothing and returns instantly, which
 * is the right default for a binary with no connectors and the wrong one for
 * chaos: an action with no duration has no window to be interrupted in, and an
 * action with no record cannot be counted. This sink announces itself on stdout
 * on both sides of the act — once before, once after — so the parent process
 * can kill a worker at a named instant and afterwards say which side of the
 * claim it landed on.
 */

const report = (event: Record<string, unknown>): void => {
  process.stdout.write(`HARNESS ${JSON.stringify(event)}\n`);
};

const number = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer; got ${raw}.`);
  }
  return value;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, ms));

export const label = (): string => process.env.HARNESS_LABEL ?? "harness";

/** Everything this process performed, for the report it prints on the way out. */
export const performed: JsonValue[] = [];

export function harnessSink(): EffectSink {
  const delay = number("HARNESS_DISPATCH_DELAY_MS") ?? 0;
  const hang = process.env.HARNESS_HANG === "1";

  return {
    async perform(runId, nodeId, effect, input) {
      // Announced *before* the action, because the window this exists to open
      // is the one between the durable claim and the action itself.
      report({ kind: "dispatching", label: label(), runId, nodeId, effect });
      if (hang) {
        // Never resolves. The only way past this line is for the process to
        // die, which is exactly what the scenario is about to do to it.
        await new Promise(() => {});
      }
      if (delay > 0) await sleep(delay);
      performed.push(input ?? null);
      report({ kind: "performed", label: label(), runId, nodeId, effect });
      return PUBLISHED;
    },
  };
}

export function harnessTransforms(): Readonly<Record<string, TransformFn>> {
  const delay = number("HARNESS_TRANSFORM_DELAY_MS") ?? 0;
  return {
    [SLOW_TRANSFORM]: async (input: JsonValue) => {
      report({ kind: "transforming", label: label() });
      if (delay > 0) await sleep(delay);
      return input;
    },
  };
}

/**
 * The deployment's policy, resolved exactly as `apps/api` and `apps/worker`
 * resolve it. A harness process that granted itself different rules would be
 * asking a different question from the one the deployment answers.
 */
export async function deploymentPolicy(): Promise<DeploymentPolicy> {
  const root = process.env.FORGE_COMPANY;
  if (root === undefined) {
    throw new Error("FORGE_COMPANY is required; the harness serves a company.");
  }
  const csv = (spec: string): readonly string[] =>
    spec
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  return loadDeploymentPolicy({
    root,
    hostCapabilities: csv(process.env.FORGE_HOST_CAPABILITIES ?? ""),
    forgeVersion: process.env.FORGE_VERSION ?? "0.1.0",
  });
}
