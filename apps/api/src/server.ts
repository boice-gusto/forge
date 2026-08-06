import {
  type DeploymentPolicy,
  loadDeploymentPolicy,
  NO_COMPANY_POLICY,
} from "@forge/company";
import { type ControlPlaneStack, createLocalStack } from "@forge/composition";
import { createDurableStack } from "@forge/composition/durable";
import { bindIntake } from "@forge/composition/intake-binding";

/**
 * Every channel a deployment serves must resolve, or a webhook that was
 * configured answers 404 and looks like the sender's fault.
 */
const refuseIntake = (problems: readonly string[]): never => {
  process.stderr.write(
    `[forge-api] The company's "connectors" adapter could not be bound:\n` +
      problems.map((problem) => `  - ${problem}\n`).join(""),
  );
  process.exit(1);
};

import { ANY_ROLE } from "@forge/ports";
import {
  createDevelopmentIdentity,
  type DevelopmentOperator,
  parseOperatorDirectory,
} from "./identity-development.js";
import { startApi } from "./main.js";
import { persistenceFrom } from "./persistence.js";

/**
 * `PORT` matters beyond taste: a suite that cannot choose a port cannot run two
 * Forges at once, and a fixed 3100 means a harness will happily adopt whatever
 * is already listening there. That is not hypothetical — a company acceptance
 * run did exactly that and spent twenty assertions failing against another
 * process's half-built server.
 */
const port = Number.parseInt(process.env.PORT ?? "3100", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be a valid port number; got ${process.env.PORT}.`);
}

/**
 * This binary ships one identity provider and it is the development one, so it
 * refuses to be the thing it is not. A production deployment binds a real IdP
 * to `IdentityPort` and starts from its own entry point; running this in its
 * place is a control plane whose authentication is a list of preshared strings
 * in an environment variable.
 *
 * The refusal used to be `NODE_ENV === "production"`, which is the wrong way
 * round: it fires only when somebody remembers to say the dangerous thing, and
 * an unset `NODE_ENV` — the state of any container nobody configured — sailed
 * straight past it. A guard that depends on being told it is needed is a guard
 * that is absent exactly when it matters.
 *
 * So the allowance is the opt-in now, and it is narrow.
 */
const DEVELOPMENT_ENVIRONMENTS = new Set(["development", "test"]);
if (!DEVELOPMENT_ENVIRONMENTS.has(process.env.NODE_ENV ?? "")) {
  throw new Error(
    "apps/api ships only the development identity provider, and its stack " +
      "binds a simulated sandbox and a stand-in model. It starts only with " +
      `NODE_ENV set to development or test; it is currently ${
        process.env.NODE_ENV === undefined
          ? "unset"
          : `"${process.env.NODE_ENV}"`
      }. Bind a real IdP to IdentityPort and compose your own entry point for ` +
      "anything else.",
  );
}

/** The zero-configuration local credential. Not a secret; it protects nothing. */
const LOCAL_CREDENTIAL = "local-development-only";

const warn = (message: string): void => {
  process.stderr.write(`[forge-api] ${message}\n`);
};

const roleList = (spec: string): readonly string[] =>
  spec
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "");

/**
 * The operator directory this process authenticates against.
 *
 * `FORGE_OPERATORS` is the real path: several operators, each with their own
 * credential and their own roles, which is what makes an approval inbox mean
 * anything and what stops two roles deciding each other's gates.
 *
 * The single-operator paths below are the documented stopgap, and roles are
 * never inferred for them — an operator holds what the deployment said they
 * hold. `ANY_ROLE` appears exactly once, in the zero-configuration case where
 * there is one operator and no directory at all, and it is announced.
 */
function directory(): readonly DevelopmentOperator[] {
  const spec = process.env.FORGE_OPERATORS;
  if (spec !== undefined) return parseOperatorDirectory(spec);

  const credential = process.env.FORGE_ADMIN_TOKEN;
  if (credential === undefined) {
    warn(
      `No FORGE_OPERATORS and no FORGE_ADMIN_TOKEN. Starting with one local operator holding every role (${ANY_ROLE}), credential "${LOCAL_CREDENTIAL}". This is a development stopgap, not authentication.`,
    );
    return [
      {
        subject: "local-operator",
        secret: LOCAL_CREDENTIAL,
        roles: [ANY_ROLE],
      },
    ];
  }

  const roles = roleList(process.env.FORGE_ROLES ?? "");
  if (roles.length === 0) {
    warn(
      "FORGE_ADMIN_TOKEN is set but FORGE_ROLES is not, so this operator holds no roles and will see and decide only gates that name nobody. Set FORGE_ROLES, or FORGE_OPERATORS for a directory.",
    );
  }
  return [
    {
      subject: process.env.FORGE_PRINCIPAL ?? "local-operator",
      secret: credential,
      roles,
    },
  ];
}

const FORGE_VERSION = "0.1.0";

/**
 * The company package this deployment serves, and the ceiling it serves it
 * under.
 *
 * The ceiling is read from the environment because the deployment operator
 * owns it — never from the manifest, which is the package asking. A package
 * that could widen its own grant by editing its own manifest would not have a
 * ceiling at all (009 §17.3).
 */
async function policy(): Promise<DeploymentPolicy> {
  const root = process.env.FORGE_COMPANY;
  if (root === undefined) {
    warn(
      "No FORGE_COMPANY. Starting with no policy packs, so every gated action " +
        "is denied by default and no capability is granted. Set FORGE_COMPANY " +
        "to the company package this deployment serves.",
    );
    return NO_COMPANY_POLICY;
  }
  return loadDeploymentPolicy({
    root,
    hostCapabilities: roleList(process.env.FORGE_HOST_CAPABILITIES ?? ""),
    forgeVersion: FORGE_VERSION,
  });
}

/**
 * One stack, built once, for the life of the process.
 *
 * `FORGE_PERSISTENCE=postgres` selects the durable root; anything else keeps
 * the in-memory one, so a contributor with no container runtime still gets a
 * working control plane. Both are constructed here and nowhere else: the
 * routes are handed a stack and cannot tell which they got.
 */
async function stack(rules: DeploymentPolicy): Promise<ControlPlaneStack> {
  // What this deployment can actually isolate. A workflow naming a profile
  // that is absent stops rather than running with less isolation than it
  // declared, so a host serving a company declares that company's profiles.
  const sandboxProfiles =
    process.env.FORGE_SANDBOX_PROFILES === undefined
      ? {}
      : { sandboxProfiles: roleList(process.env.FORGE_SANDBOX_PROFILES) };
  const shared = {
    rules: rules.rules,
    grants: rules.grants,
    environment: "production",
    ...sandboxProfiles,
  };

  if (persistenceFrom(process.env.FORGE_PERSISTENCE) === "memory") {
    return createLocalStack(shared);
  }
  return createDurableStack(shared);
}

/**
 * What this binary is, stated at boot rather than left to be discovered.
 *
 * Its sibling `apps/worker` refuses to start on any of these, because a worker
 * is the process that acts and a stand-in there is a gated action performed
 * nowhere, or a model nobody consulted shown to a human as their decision. A
 * control plane is not that process, and in memory mode it is a development
 * tool that has just refused to run anywhere else — so here the same facts are
 * a notice rather than a refusal. Silence was the only option that was wrong.
 */
process.stderr.write(
  "[forge-api] Development control plane: preshared-credential identity, a " +
    "simulated sandbox, and a stand-in model. Nothing here provides " +
    "isolation or talks to a real provider.\n",
);

const resolved = await policy();

const controlPlane = await stack(resolved);

/**
 * The channels this control plane serves, from the company that named them
 * and the environment that holds their secrets.
 *
 * The durable stack's own pool backs the ledger, so a fleet deduplicates. In
 * memory mode there is no pool and the in-process ledger is used, which
 * deduplicates for one process — correct for a development control plane that
 * has already refused to be anything else.
 */
const intake = bindIntake(
  resolved.adapters.connectors,
  (controlPlane as { pool?: import("pg").Pool }).pool,
  refuseIntake,
);

await startApi(
  {
    build: {
      version: process.env.FORGE_VERSION ?? FORGE_VERSION,
      gitSha: process.env.FORGE_GIT_SHA ?? "local",
      buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
    },
    // The queue's own answer, per probe. A control plane that cannot reach
    // its queue accepts runs it will never advance, and saying "healthy"
    // while that is true is how a fleet stays green through an outage.
    dependencies: async () => ({
      queue: (await controlPlane.queue.health()).available
        ? "healthy"
        : "unavailable",
      persistence: "healthy",
    }),
    identity: createDevelopmentIdentity(directory()),
    ...(intake === undefined ? {} : { intake }),
    ...(process.env.FORGE_PUBLIC_URL === undefined
      ? {}
      : { publicUrl: process.env.FORGE_PUBLIC_URL }),
    stack: controlPlane,
  },
  port,
);
