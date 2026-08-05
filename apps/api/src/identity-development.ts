import type {
  IdentityCredential,
  IdentityPort,
  Principal,
} from "./identity.js";

/**
 * The **development** identity provider.
 *
 * It is to identity what `provider-mock` is to a model: a real seam with a
 * stand-in behind it. There is no IdP in this environment, so a credential
 * here is a preshared per-operator secret checked against a directory the
 * deployment states, and the directory is the whole of the org chart.
 *
 * It is named `development` in the file, the factory and the `provider` field,
 * because the failure mode worth designing against is somebody mistaking it
 * for authentication. Concretely, it is not production-shaped:
 *
 * - The secret is compared by map lookup, not in constant time.
 * - A secret is a bearer of the operator's whole authority — no expiry, no
 *   rotation, no second factor, no revocation short of a restart.
 * - Membership is whatever the environment said at boot; nothing re-resolves
 *   when somebody changes teams.
 *
 * A deployment replaces this file's factory with one that validates an OIDC
 * token and reads group membership from the directory. Nothing else moves:
 * `IdentityPort` is what the rest of the API depends on.
 */

export interface DevelopmentOperator {
  readonly subject: string;
  /**
   * Preshared. From the environment or a secret manager, never committed
   * (014 §6.1) — a directory literal in source is a directory of credentials.
   */
  readonly secret: string;
  readonly roles: readonly string[];
}

/**
 * A bearer header and a session login carry the same thing here: an operator's
 * secret. Anything else is refused rather than guessed at.
 */
const ACCEPTED_KINDS: ReadonlySet<string> = new Set([
  "bearer",
  "operator-secret",
]);

export function createDevelopmentIdentity(
  operators: readonly DevelopmentOperator[],
): IdentityPort {
  const byCredential = new Map<string, Principal>();

  for (const operator of operators) {
    if (operator.secret === "") {
      throw new Error(
        `Operator ${operator.subject} has an empty credential, which would authenticate a caller who sent nothing.`,
      );
    }
    if (byCredential.has(operator.secret)) {
      throw new Error(
        `Two operators share one credential, so neither could be told apart; ${operator.subject} is the second.`,
      );
    }
    byCredential.set(operator.secret, {
      subject: operator.subject,
      roles: [...operator.roles],
    });
  }

  return {
    provider: "development",
    async authenticate(credential: IdentityCredential) {
      if (!ACCEPTED_KINDS.has(credential.kind)) return undefined;
      return byCredential.get(credential.value);
    },
  };
}

/**
 * A directory from one environment variable:
 * `subject:secret:role,role;subject:secret:role`.
 *
 * Malformed input throws at boot rather than yielding a smaller directory than
 * the operator wrote — a silently dropped entry is an operator who cannot sign
 * in, or worse, a role nobody holds and a gate nobody can decide.
 */
export function parseOperatorDirectory(
  spec: string,
): readonly DevelopmentOperator[] {
  const entries = spec
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    throw new Error(
      "FORGE_OPERATORS is set but names no operator; a control plane nobody can authenticate to is not a safer one.",
    );
  }

  return entries.map((entry) => {
    const [subject, secret, roles] = entry.split(":");
    if (
      subject === undefined ||
      subject.trim() === "" ||
      secret === undefined ||
      secret.trim() === ""
    ) {
      throw new Error(
        `FORGE_OPERATORS entry "${entry}" is not <subject>:<secret>:<role,role>.`,
      );
    }
    return {
      subject: subject.trim(),
      secret: secret.trim(),
      roles: (roles ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter((role) => role !== ""),
    };
  });
}
