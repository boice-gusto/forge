/**
 * The environment variables more than one process reads.
 *
 * Not every `FORGE_*` name — most are read once, by the one binary that cares,
 * and a constant for those is indirection with nothing on the other side. What
 * is here is the set `apps/api` and `apps/worker` *both* read, which is a
 * different thing: they are two processes that must agree about one
 * deployment, and a typo in either is a setting silently ignored by one half
 * of it.
 *
 * That failure has a particular shape worth naming. A worker that misreads
 * `FORGE_COMPANY` does not crash — it starts with no company, denies every
 * gated action by default, and the run fails in a way that reads as a policy
 * problem. The names are the agreement; this is where it lives.
 */
export const FORGE_ENV = {
  /** The company package a deployment serves. Both processes must load one. */
  company: "FORGE_COMPANY",
  /** The capability ceiling, from the operator and never from a manifest. */
  hostCapabilities: "FORGE_HOST_CAPABILITIES",
  /** Sandbox profile aliases this host can provision. */
  sandboxProfiles: "FORGE_SANDBOX_PROFILES",
  /** Where the control plane is reachable, for links a connector posts back. */
  publicUrl: "FORGE_PUBLIC_URL",
  version: "FORGE_VERSION",
  gitSha: "FORGE_GIT_SHA",
  buildTime: "FORGE_BUILD_TIME",
} as const;

export type ForgeEnvVar = (typeof FORGE_ENV)[keyof typeof FORGE_ENV];

/** Reads one, without pretending an empty string is a value. */
export const readEnv = (
  name: ForgeEnvVar,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};
