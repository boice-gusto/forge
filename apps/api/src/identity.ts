import { randomBytes } from "node:crypto";

import { ANY_ROLE } from "@forge/ports";

/**
 * Identity, behind a port.
 *
 * An identity provider is a vendor like any other here, so it sits behind an
 * interface and a deployment binds an implementation. There is no IdP to
 * integrate against in this environment, so `identity-development.ts` stands
 * in for one exactly as `provider-mock` stands in for a model.
 *
 * Two properties are load-bearing:
 *
 * - A principal and its roles come from the credential the caller presented,
 *   never from a body field or a query parameter. A `principal` in a payload
 *   is the exact mistake this boundary exists to prevent.
 * - Resolution fails closed. An unparsable, expired or unknown credential is
 *   refused; it is never downgraded to anonymous-but-allowed.
 */

/** What a caller presented. Opaque here — its shape is the provider's business. */
export interface IdentityCredential {
  readonly kind: string;
  readonly value: string;
}

/**
 * Who is acting.
 *
 * `roles` is membership, resolved by the provider. A policy rule's `approvers`
 * names roles rather than people, so a boundary that resolved only an identity
 * would leave every role-named gate in nobody's inbox.
 */
export interface Principal {
  readonly subject: string;
  readonly roles: readonly string[];
}

export interface IdentityPort {
  /** Names the bound provider, so a deployment can see which one it wired. */
  readonly provider: string;
  authenticate(credential: IdentityCredential): Promise<Principal | undefined>;
}

/**
 * A working day. An operator who has been away longer authenticates again,
 * which is the difference between a session and a token that never dies.
 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface Session {
  readonly sessionId: string;
  /**
   * Proves an unsafe request came from the Forge UI rather than from another
   * origin the browser also attached the cookie to (012 §8). Held server-side
   * so it can be compared rather than merely echoed.
   */
  readonly csrfToken: string;
  readonly principal: Principal;
  readonly expiresAt: string;
}

export interface SessionStore {
  create(principal: Principal): Session;
  /** Undefined for unknown *or* expired: an expired session is not a session. */
  get(sessionId: string): Session | undefined;
  revoke(sessionId: string): void;
}

export interface SessionStoreOptions {
  readonly ttlMs?: number;
  /** Injected so a suite can age a session out without waiting eight hours. */
  readonly now?: () => number;
}

export function createSessionStore(
  options: SessionStoreOptions = {},
): SessionStore {
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();

  return {
    create(principal) {
      const session: Session = {
        sessionId: randomBytes(32).toString("hex"),
        csrfToken: randomBytes(32).toString("hex"),
        principal,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      sessions.set(session.sessionId, session);
      return session;
    },

    get(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      if (now() >= Date.parse(session.expiresAt)) {
        sessions.delete(sessionId);
        return undefined;
      }
      return session;
    },

    revoke(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

/**
 * May this principal decide a gate these approvers name?
 *
 * The same rule the approval store applies when it builds the inbox
 * (`ApprovalPort.listPendingFor`): a gate naming nobody is open to any
 * authenticated operator, and otherwise the caller must hold one of the names.
 * It is restated here because the store never sees a decision, and
 * `runs.test.ts` asserts the two agree — an inbox showing a gate nobody may
 * decide, and a decision route wider than the inbox, are both silent failures.
 */
export function mayDecide(
  principal: Principal,
  approvers: readonly string[],
): boolean {
  if (approvers.length === 0) return true;
  const held = new Set<string>([principal.subject, ...principal.roles]);
  return held.has(ANY_ROLE) || approvers.some((approver) => held.has(approver));
}

/**
 * One cookie's value from a `Cookie` header.
 *
 * Hand-rolled because the API has no cookie plugin: this is the whole of what
 * is needed, and a lockfile change for a name/value split would not be.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}
