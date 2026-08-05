import { ANY_ROLE } from "@forge/ports";
import { describe, expect, test } from "vitest";
import { createSessionStore, mayDecide, readCookie } from "./identity.js";
import {
  createDevelopmentIdentity,
  parseOperatorDirectory,
} from "./identity-development.js";

const DIRECTORY = [
  { subject: "sam@example.test", secret: "sam-cred", roles: ["role-a"] },
  {
    subject: "ash@example.test",
    secret: "ash-cred",
    roles: ["role-a", "role-b"],
  },
];

describe("the development identity provider resolves membership, not just identity", () => {
  test("a known credential yields the subject and the roles the directory gave it", async () => {
    const identity = createDevelopmentIdentity(DIRECTORY);

    expect(
      await identity.authenticate({ kind: "bearer", value: "ash-cred" }),
    ).toEqual({
      subject: "ash@example.test",
      roles: ["role-a", "role-b"],
    });
  });

  test("it names itself, so a deployment can see which provider it wired", () => {
    expect(createDevelopmentIdentity(DIRECTORY).provider).toBe("development");
  });

  test("an unknown credential is refused, never downgraded to anonymous", async () => {
    const identity = createDevelopmentIdentity(DIRECTORY);

    expect(
      await identity.authenticate({ kind: "bearer", value: "guessed" }),
    ).toBeUndefined();
  });

  test("a credential kind this provider does not understand is refused", async () => {
    // An OIDC token is not a preshared secret. Refusing rather than trying it
    // as one is what stops a provider swap from silently half-working.
    const identity = createDevelopmentIdentity(DIRECTORY);

    expect(
      await identity.authenticate({ kind: "oidc-id-token", value: "sam-cred" }),
    ).toBeUndefined();
  });

  test("a session login and a bearer header reach the same principal", async () => {
    const identity = createDevelopmentIdentity(DIRECTORY);

    expect(
      await identity.authenticate({
        kind: "operator-secret",
        value: "sam-cred",
      }),
    ).toEqual(
      await identity.authenticate({ kind: "bearer", value: "sam-cred" }),
    );
  });

  test("an empty credential is refused at construction, not at sign-in", () => {
    // It would otherwise authenticate a caller who sent nothing at all.
    expect(() =>
      createDevelopmentIdentity([
        { subject: "nobody", secret: "", roles: ["role-a"] },
      ]),
    ).toThrow(/empty credential/);
  });

  test("two operators sharing one credential is refused, not resolved to one", () => {
    expect(() =>
      createDevelopmentIdentity([
        { subject: "sam@example.test", secret: "same", roles: ["role-a"] },
        { subject: "ash@example.test", secret: "same", roles: ["role-b"] },
      ]),
    ).toThrow(/share one credential/);
  });

  test("the directory it was given cannot be widened afterwards", async () => {
    const roles = ["role-a"];
    const identity = createDevelopmentIdentity([
      { subject: "sam@example.test", secret: "sam-cred", roles },
    ]);
    roles.push(ANY_ROLE);

    const principal = await identity.authenticate({
      kind: "bearer",
      value: "sam-cred",
    });
    expect(principal?.roles).toEqual(["role-a"]);
  });
});

describe("the operator directory is read from configuration, not from source", () => {
  test("subjects, credentials and roles all survive the round trip", () => {
    expect(
      parseOperatorDirectory(
        "sam@example.test:sam-cred:role-a,role-b; ash@example.test:ash-cred:role-b",
      ),
    ).toEqual([
      {
        subject: "sam@example.test",
        secret: "sam-cred",
        roles: ["role-a", "role-b"],
      },
      { subject: "ash@example.test", secret: "ash-cred", roles: ["role-b"] },
    ]);
  });

  test("an operator with no roles is allowed, and holds none", () => {
    // Not an error: a read-only operator is a real thing. They will see only
    // gates that name nobody, which is what holding no roles means.
    expect(parseOperatorDirectory("watcher:watch-cred:")).toEqual([
      { subject: "watcher", secret: "watch-cred", roles: [] },
    ]);
  });

  test("a malformed entry throws at boot rather than quietly shrinking the directory", () => {
    expect(() => parseOperatorDirectory("sam@example.test")).toThrow(
      /<subject>:<secret>:<role,role>/,
    );
    expect(() => parseOperatorDirectory("sam@example.test::role-a")).toThrow(
      /<subject>:<secret>:<role,role>/,
    );
    expect(() => parseOperatorDirectory(":sam-cred:role-a")).toThrow(
      /<subject>:<secret>:<role,role>/,
    );
  });

  test("a directory naming nobody is refused", () => {
    expect(() => parseOperatorDirectory("  ;  ")).toThrow(/names no operator/);
  });
});

describe("a session expires; it is not a cookie that lives forever", () => {
  test("a fresh session resolves to its principal", () => {
    const sessions = createSessionStore();
    const session = sessions.create({ subject: "sam", roles: ["role-a"] });

    expect(sessions.get(session.sessionId)?.principal.roles).toEqual([
      "role-a",
    ]);
  });

  test("each session gets its own id and its own CSRF token", () => {
    const sessions = createSessionStore();
    const first = sessions.create({ subject: "sam", roles: [] });
    const second = sessions.create({ subject: "sam", roles: [] });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    expect(first.csrfToken).not.toBe(first.sessionId);
  });

  test("a session past its expiry is unknown, not merely stale", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const sessions = createSessionStore({ ttlMs: 1000, now: () => now });
    const session = sessions.create({ subject: "sam", roles: ["role-a"] });

    now += 1000;
    expect(sessions.get(session.sessionId)).toBeUndefined();
  });

  test("an unknown session id resolves to nothing", () => {
    expect(createSessionStore().get("not-a-session")).toBeUndefined();
  });

  test("a revoked session stops resolving immediately", () => {
    const sessions = createSessionStore();
    const session = sessions.create({ subject: "sam", roles: [] });

    sessions.revoke(session.sessionId);
    expect(sessions.get(session.sessionId)).toBeUndefined();
  });
});

describe("who may decide a gate", () => {
  const sam = { subject: "sam@example.test", roles: ["role-a"] };

  test("a gate naming nobody is open to any authenticated operator", () => {
    expect(mayDecide(sam, [])).toBe(true);
  });

  test("a role the caller holds is enough", () => {
    expect(mayDecide(sam, ["role-a"])).toBe(true);
  });

  test("a role the caller does not hold is not", () => {
    expect(mayDecide(sam, ["role-b"])).toBe(false);
  });

  test("a gate may also name a person directly", () => {
    expect(mayDecide(sam, ["sam@example.test"])).toBe(true);
  });

  test("every role decides everything, which is why it must be explicit", () => {
    expect(mayDecide({ subject: "op", roles: [ANY_ROLE] }, ["role-b"])).toBe(
      true,
    );
  });

  test("holding no roles decides nothing that names anybody", () => {
    expect(mayDecide({ subject: "op", roles: [] }, ["role-a"])).toBe(false);
  });
});

describe("reading one cookie out of a header", () => {
  test("finds the named cookie among others", () => {
    expect(
      readCookie("theme=dark; forge_session=abc; other=1", "forge_session"),
    ).toBe("abc");
  });

  test("a header without it, or no header at all, is undefined", () => {
    expect(readCookie("theme=dark", "forge_session")).toBeUndefined();
    expect(readCookie(undefined, "forge_session")).toBeUndefined();
  });

  test("a name that only looks like a prefix does not match", () => {
    expect(
      readCookie("forge_session_other=abc", "forge_session"),
    ).toBeUndefined();
  });

  test("a valueless fragment is skipped rather than mistaken for a match", () => {
    expect(readCookie("flag; forge_session=abc", "forge_session")).toBe("abc");
  });
});
