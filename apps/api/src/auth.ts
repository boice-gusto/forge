import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  type IdentityPort,
  type Principal,
  readCookie,
  type Session,
  type SessionStore,
} from "./identity.js";

/**
 * Establishing and presenting a session.
 *
 * A session is a server-held record — subject, roles, expiry, CSRF token —
 * created when an operator presents a credential the bound identity provider
 * recognises. The browser gets an opaque, `HttpOnly` cookie naming it and
 * nothing else: the roles live on the server, so no amount of tampering with
 * what the browser holds can widen them.
 *
 * Two transports reach one identity:
 *
 * - `Authorization: Bearer <credential>` for a programmatic caller — the SDK,
 *   the CLI, a company's acceptance suite. It carries no ambient authority
 *   (nothing attaches it on the caller's behalf), so it needs no CSRF token.
 * - The session cookie for the operator UI. A cookie *is* ambient — a browser
 *   sends it on a cross-site request without being asked — so an unsafe method
 *   must also carry the session's CSRF token (012 §8).
 */

export const SESSION_COOKIE = "forge_session";
export const CSRF_HEADER = "x-forge-csrf";

/** Methods that change nothing, and so cannot be the point of a forged request. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

interface LoginBody {
  readonly credential?: { readonly kind?: unknown; readonly value?: unknown };
}

/**
 * What the caller is told about their own session. The CSRF token is returned
 * to a same-origin reader deliberately: it is the one part the browser must be
 * able to echo, and another origin cannot read this response to obtain it.
 */
function sessionView(session: Session) {
  return {
    subject: session.principal.subject,
    roles: session.principal.roles,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  };
}

function cookie(
  request: FastifyRequest,
  value: string,
  maxAge: number,
): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    // A script cannot read it, so an XSS cannot lift the session out of the tab.
    "HttpOnly",
    // 012 §8. The UI is same-origin with the API (the dev server proxies /v1),
    // which is what makes Strict workable rather than merely aspirational.
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    // Omitted only on plain http, which is local development. A cookie marked
    // Secure over http is simply never sent, and the UI would not work at all.
    ...(request.protocol === "https" ? ["Secure"] : []),
  ].join("; ");
}

function issue(
  request: FastifyRequest,
  reply: FastifyReply,
  session: Session,
): void {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(session.expiresAt) - Date.now()) / 1000),
  );
  reply.header("set-cookie", cookie(request, session.sessionId, seconds));
}

function clear(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("set-cookie", cookie(request, "", 0));
}

/** The live session a request presents, if it presents one at all. */
function sessionOf(
  request: FastifyRequest,
  sessions: SessionStore,
): Session | undefined {
  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (sessionId === undefined) return undefined;
  return sessions.get(sessionId);
}

export interface AuthOptions {
  readonly identity: IdentityPort;
  readonly sessions: SessionStore;
}

/**
 * The acting principal for a request, or `undefined`.
 *
 * Everything is refused that is not positively recognised: an unknown scheme,
 * an empty credential, a cookie naming an expired or revoked session, and a
 * cookie-borne unsafe request whose CSRF token does not match. None of these
 * becomes an anonymous caller who is nonetheless allowed through.
 */
export function createRequestAuthenticator(
  options: AuthOptions,
): (request: FastifyRequest) => Promise<Principal | undefined> {
  return async (request) => {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const separator = authorization.indexOf(" ");
      if (separator === -1) return undefined;
      if (authorization.slice(0, separator).toLowerCase() !== "bearer")
        return undefined;
      const value = authorization.slice(separator + 1).trim();
      if (value === "") return undefined;
      return options.identity.authenticate({ kind: "bearer", value });
    }

    const session = sessionOf(request, options.sessions);
    if (session === undefined) return undefined;
    if (SAFE_METHODS.has(request.method)) return session.principal;
    return request.headers[CSRF_HEADER] === session.csrfToken
      ? session.principal
      : undefined;
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthOptions,
): void {
  /**
   * Sign in. The only route reachable without a session, because it is the one
   * that creates one — and it still refuses every credential the provider does
   * not recognise.
   */
  app.post("/v1/auth/session", async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody;
    const kind = body.credential?.kind;
    const value = body.credential?.value;
    if (typeof kind !== "string" || typeof value !== "string") {
      return reply.code(400).send({
        status: "invalid",
        code: "CREDENTIAL_INVALID",
        message: "credential must carry a kind and a value.",
      });
    }

    const principal = await options.identity.authenticate({ kind, value });
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    const session = options.sessions.create(principal);
    issue(request, reply, session);
    return reply.code(201).send(sessionView(session));
  });

  /** Who the browser currently is, and the CSRF token to act with. */
  app.get("/v1/auth/session", async (request, reply) => {
    const session = sessionOf(request, options.sessions);
    if (session === undefined)
      return reply.code(401).send({ status: "unauthorized" });
    return reply.send(sessionView(session));
  });

  /**
   * Sign out. Unsafe, so it carries the CSRF token like any other unsafe
   * request — otherwise another origin could log an operator out at will.
   */
  app.delete("/v1/auth/session", async (request, reply) => {
    const session = sessionOf(request, options.sessions);
    if (session === undefined)
      return reply.code(401).send({ status: "unauthorized" });
    if (request.headers[CSRF_HEADER] !== session.csrfToken) {
      return reply.code(403).send({
        status: "forbidden",
        code: "CSRF_INVALID",
        message: "This request did not carry the session's CSRF token.",
      });
    }

    options.sessions.revoke(session.sessionId);
    clear(request, reply);
    return reply.send({ status: "signed_out" });
  });
}
