import { type ControlPlaneStack, createLocalStack } from "@forge/composition";
import { createDurableStack } from "@forge/composition/durable";
import { ANY_ROLE } from "@forge/ports";

import {
  type DeploymentPolicy,
  loadDeploymentPolicy,
  NO_COMPANY_POLICY,
} from "./company.js";
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
 * to `IdentityPort` and starts from its own entry point; until then, running
 * this with `NODE_ENV=production` would be a control plane whose authentication
 * is a list of preshared strings in an environment variable.
 */
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "apps/api ships only the development identity provider. Bind a real IdP to IdentityPort before running in production.",
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

const resolved = await policy();

await startApi(
  {
    build: {
      version: process.env.FORGE_VERSION ?? FORGE_VERSION,
      gitSha: process.env.FORGE_GIT_SHA ?? "local",
      buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
    },
    dependencies: { queue: "healthy", persistence: "healthy" },
    identity: createDevelopmentIdentity(directory()),
    stack: await stack(resolved),
  },
  port,
);
