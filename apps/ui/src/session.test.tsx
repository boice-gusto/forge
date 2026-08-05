// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { createForgeSessionClient, type ForgeSessionClient } from "@forge/sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { OperatorSession } from "./session.js";

afterEach(cleanup);

const SESSION = {
  subject: "sam@example.test",
  roles: ["benefits-specialist"],
  expiresAt: "2026-01-01T20:00:00.000Z",
  csrfToken: "csrf-1",
};

interface Route {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * Driven through a real `createForgeSessionClient` over a stub fetch, so the
 * wire shape is part of what these tests defend rather than a hand-written
 * double that could drift from it.
 */
function stubApi(routes: Readonly<Record<string, Route>>) {
  const calls: { url: string; body: unknown }[] = [];

  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url.slice(url.indexOf("/v1"))}`;
    calls.push({
      url: key,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const route = routes[key];
    if (route === undefined)
      return new Response(JSON.stringify({ status: "not_found" }), {
        status: 404,
      });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  };

  return { fetchStub: fetchStub as unknown as typeof globalThis.fetch, calls };
}

function draw(sessions: ForgeSessionClient) {
  render(
    <OperatorSession sessions={sessions}>
      {(session) => <p>Console for {session.csrfToken}</p>}
    </OperatorSession>,
  );
}

function client(routes: Readonly<Record<string, Route>>) {
  const { fetchStub, calls } = stubApi(routes);
  return {
    sessions: createForgeSessionClient({
      baseUrl: "",
      fetch: fetchStub,
    }),
    calls,
  };
}

const anonymous = {
  "GET /v1/auth/session": {
    status: 401,
    body: { status: "unauthorized" },
  },
};

async function signIn(value = "sam-cred"): Promise<void> {
  await userEvent.type(screen.getByLabelText("Operator credential"), value);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("nothing is shown until the control plane says who you are", () => {
  test("an existing cookie resolves to a session without signing in again", async () => {
    const { sessions, calls } = client({
      "GET /v1/auth/session": { body: SESSION },
    });
    draw(sessions);

    expect(await screen.findByText("Console for csrf-1")).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toEqual(["GET /v1/auth/session"]);
  });

  test("no session means a sign-in form and no console at all", async () => {
    const { sessions } = client(anonymous);
    draw(sessions);

    expect(
      await screen.findByLabelText("Operator credential"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Console for/)).toBeNull();
  });

  test("the credential field is a password field, so it is never on screen", async () => {
    const { sessions } = client(anonymous);
    draw(sessions);

    expect(await screen.findByLabelText("Operator credential")).toHaveAttribute(
      "type",
      "password",
    );
  });
});

describe("signing in exchanges a credential for a session", () => {
  test("the credential goes to the control plane and the console appears", async () => {
    const { sessions, calls } = client({
      ...anonymous,
      "POST /v1/auth/session": { status: 201, body: SESSION },
    });
    draw(sessions);
    await screen.findByLabelText("Operator credential");

    await signIn();

    expect(await screen.findByText("Console for csrf-1")).toBeInTheDocument();
    expect(calls).toContainEqual({
      url: "POST /v1/auth/session",
      body: { credential: { kind: "operator-secret", value: "sam-cred" } },
    });
  });

  test("the roles the server resolved are shown, not any the page decided", async () => {
    const { sessions } = client({ "GET /v1/auth/session": { body: SESSION } });
    draw(sessions);

    expect(await screen.findByText(/Signed in as/)).toHaveTextContent(
      "benefits-specialist",
    );
  });

  test("an operator holding no roles is told so, rather than shown an empty inbox", async () => {
    const { sessions } = client({
      "GET /v1/auth/session": { body: { ...SESSION, roles: [] } },
    });
    draw(sessions);

    expect(await screen.findByText(/no roles/)).toBeInTheDocument();
  });

  test("a refused credential says so and asks again", async () => {
    const { sessions } = client({
      ...anonymous,
      "POST /v1/auth/session": {
        status: 401,
        body: { status: "unauthorized" },
      },
    });
    draw(sessions);
    await screen.findByLabelText("Operator credential");

    await signIn("wrong");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That credential was not recognised",
    );
    expect(screen.queryByText(/^Console for/)).toBeNull();
  });

  test("a control plane that is down reports the failure, not a bad password", async () => {
    const { sessions } = client({
      ...anonymous,
      "POST /v1/auth/session": {
        status: 503,
        body: { code: "UNAVAILABLE", message: "control plane restarting" },
      },
    });
    draw(sessions);
    await screen.findByLabelText("Operator credential");

    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "control plane restarting",
    );
  });

  test("the credential is cleared from the page once it has been exchanged", async () => {
    const { sessions } = client({
      ...anonymous,
      "POST /v1/auth/session": { status: 201, body: SESSION },
    });
    draw(sessions);
    await screen.findByLabelText("Operator credential");

    await signIn();
    await screen.findByText("Console for csrf-1");

    expect(screen.queryByLabelText("Operator credential")).toBeNull();
  });
});

describe("signing out ends the session on the server", () => {
  test("the CSRF token is sent and the console is taken away", async () => {
    const { sessions, calls } = client({
      "GET /v1/auth/session": { body: SESSION },
      "DELETE /v1/auth/session": { body: { status: "signed_out" } },
    });
    draw(sessions);
    await screen.findByText("Console for csrf-1");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByLabelText("Operator credential"),
    ).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toContain("DELETE /v1/auth/session");
  });
});

describe("the browser holds no durable credential of its own", () => {
  test("nothing is written to session or local storage", async () => {
    const setSession = vi.spyOn(Storage.prototype, "setItem");
    const { sessions } = client({
      ...anonymous,
      "POST /v1/auth/session": { status: 201, body: SESSION },
    });
    draw(sessions);
    await screen.findByLabelText("Operator credential");

    await signIn();
    await screen.findByText("Console for csrf-1");

    // The session lives on the server behind an HttpOnly cookie. A token in
    // storage would outlive the tab and be readable by any script on the page.
    expect(setSession).not.toHaveBeenCalled();
    setSession.mockRestore();
  });
});
