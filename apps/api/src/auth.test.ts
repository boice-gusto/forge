import { describe, expect, test } from "vitest";

import { CSRF_HEADER, SESSION_COOKIE } from "./auth.js";
import { createSessionStore, type SessionStore } from "./identity.js";
import { createDevelopmentIdentity } from "./identity-development.js";
import { createApiApp } from "./main.js";

const DIRECTORY = [
  { subject: "sam@example.test", secret: "sam-cred", roles: ["role-a"] },
];

function app(sessions?: SessionStore) {
  return createApiApp({
    build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
    dependencies: { queue: "healthy", persistence: "healthy" },
    identity: createDevelopmentIdentity(DIRECTORY),
    ...(sessions === undefined ? {} : { sessions }),
  });
}

const login = (server: ReturnType<typeof app>, value = "sam-cred") =>
  server.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { credential: { kind: "operator-secret", value } },
  });

/** The `Set-Cookie` the response issued, as one string. */
function setCookie(headers: Record<string, unknown>): string {
  const header = headers["set-cookie"];
  return Array.isArray(header) ? header.join("\n") : String(header);
}

function cookieHeader(headers: Record<string, unknown>): string {
  const [pair] = setCookie(headers).split(";");
  return String(pair);
}

describe("a session is established by a credential the provider recognises", () => {
  test("signing in returns the principal the server resolved, not one the client asked for", async () => {
    const response = await login(app());

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      subject: "sam@example.test",
      roles: ["role-a"],
    });
    expect(response.json().csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the cookie is opaque, HttpOnly and SameSite=Strict", async () => {
    const response = await login(app());
    const cookie = setCookie(response.headers);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Nothing about who the operator is, or what they may do, travels in it.
    expect(cookie).not.toContain("sam@example.test");
    expect(cookie).not.toContain("role-a");
    expect(cookie).not.toContain(response.json().csrfToken);
  });

  test("a refused credential creates no session at all", async () => {
    const response = await login(app(), "wrong");

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  test("a login without a well-formed credential is refused rather than guessed at", async () => {
    for (const payload of [
      {},
      { credential: {} },
      { credential: "sam-cred" },
    ]) {
      const response = await app().inject({
        method: "POST",
        url: "/v1/auth/session",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("CREDENTIAL_INVALID");
    }
  });

  test("a reload learns who it is from the cookie alone", async () => {
    const server = app();
    const established = await login(server);

    const current = await server.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: cookieHeader(established.headers) },
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      subject: "sam@example.test",
      csrfToken: established.json().csrfToken,
    });
  });

  test("a cookie naming no live session is refused", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: `${SESSION_COOKIE}=invented` },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("an expired session is refused, not renewed", () => {
  test("the control plane stops answering once the session has aged out", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const server = app(createSessionStore({ ttlMs: 60_000, now: () => now }));
    const established = await login(server);
    const cookie = cookieHeader(established.headers);

    const before = await server.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    now += 60_000;

    const after = await server.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("a cookie is ambient, so an unsafe request must prove it was intended", () => {
  async function signedIn() {
    const server = app();
    const established = await login(server);
    return {
      server,
      cookie: cookieHeader(established.headers),
      csrfToken: established.json().csrfToken as string,
    };
  }

  test("a safe request needs no CSRF token", async () => {
    const { server, cookie } = await signedIn();

    const response = await server.inject({
      method: "GET",
      url: "/v1/approvals",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
  });

  test("an unsafe request without the CSRF token is refused", async () => {
    // The whole point: another origin can make the browser send the cookie.
    // It cannot make the browser send this header with the right value.
    const { server, cookie } = await signedIn();

    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { cookie },
      payload: { workflow: {} },
    });

    expect(response.statusCode).toBe(401);
  });

  test("an unsafe request with somebody else's CSRF token is refused", async () => {
    const { server, cookie } = await signedIn();
    const other = await login(server);

    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { cookie, [CSRF_HEADER]: other.json().csrfToken },
      payload: { workflow: {} },
    });

    expect(response.statusCode).toBe(401);
  });

  test("an unsafe request carrying the session's own token is accepted", async () => {
    const { server, cookie, csrfToken } = await signedIn();

    const response = await server.inject({
      method: "POST",
      url: "/v1/workflows/compile",
      headers: { cookie, [CSRF_HEADER]: csrfToken },
      payload: { workflow: {} },
    });

    // Refused for its content, which means it got past the boundary.
    expect(response.statusCode).toBe(422);
  });

  test("signing out needs the CSRF token too, or any site could do it", async () => {
    const { server, cookie, csrfToken } = await signedIn();

    const forged = await server.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers: { cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().code).toBe("CSRF_INVALID");

    const intended = await server.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers: { cookie, [CSRF_HEADER]: csrfToken },
    });
    expect(intended.statusCode).toBe(200);
    expect(setCookie(intended.headers)).toContain("Max-Age=0");

    // And the session is gone, not merely forgotten by the browser.
    const after = await server.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  test("a bearer credential needs no CSRF token, because nothing attaches it for you", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/v1/workflows/compile",
      headers: { authorization: "Bearer sam-cred" },
      payload: { workflow: {} },
    });

    expect(response.statusCode).toBe(422);
  });
});

describe("the Authorization header is parsed strictly", () => {
  test.each([
    ["a scheme with no value", "Bearer"],
    ["an empty value", "Bearer   "],
    ["a scheme this API does not speak", "Basic sam-cred"],
    ["a bare credential with no scheme", "sam-cred"],
  ])("%s is refused", async (_name, authorization) => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization },
    });

    expect(response.statusCode).toBe(401);
  });

  test("the scheme is matched case-insensitively, as HTTP requires", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: "bearer sam-cred" },
    });

    expect(response.statusCode).toBe(200);
  });

  test("a bearer header takes precedence over a cookie and is not topped up by it", async () => {
    // Otherwise a stale cookie could quietly supply roles the bearer lacks.
    const server = app();
    const established = await login(server);

    const response = await server.inject({
      method: "GET",
      url: "/v1/runs",
      headers: {
        authorization: "Bearer wrong",
        cookie: cookieHeader(established.headers),
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
