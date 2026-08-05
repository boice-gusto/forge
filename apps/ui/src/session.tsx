import type { ForgeSessionClient, SessionView } from "@forge/sdk";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

/**
 * The operator's session.
 *
 * Nothing durable is held in the browser. The session lives on the server and
 * the browser holds only an `HttpOnly` cookie naming it, which no script here
 * can read — so there is no long-lived bearer token in `sessionStorage` for a
 * cross-site script to lift, and no roles the page could assert for itself.
 * The one thing this component does keep is the session's CSRF token, in
 * memory for the life of the tab, because an unsafe request has to echo it
 * (012 §8).
 *
 * The credential field is the *development* provider's sign-in: one preshared
 * string. A deployment with a real IdP replaces this form with a redirect to
 * the IdP and hands what comes back to the same `signIn` call.
 */

export interface OperatorSessionProps {
  readonly sessions: ForgeSessionClient;
  /** Rendered once a session exists. Given the session so it can use the token. */
  readonly children: (session: SessionView) => ReactNode;
}

type State =
  | { readonly kind: "checking" }
  | { readonly kind: "anonymous"; readonly message?: string }
  | { readonly kind: "active"; readonly session: SessionView };

export function OperatorSession({ sessions, children }: OperatorSessionProps) {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);

  // A reload should not mean signing in again: the cookie may already name a
  // live session, and this is the only way to learn its CSRF token.
  useEffect(() => {
    let live = true;
    void sessions.current().then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { kind: "active", session: result.value }
          : { kind: "anonymous" },
      );
    });
    return () => {
      live = false;
    };
  }, [sessions]);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    const result = await sessions.signIn({
      kind: "operator-secret",
      value: credential,
    });
    setBusy(false);
    if (!result.ok) {
      // A refused credential says so and asks again. It never falls through to
      // the control plane as an anonymous caller who is somehow still allowed.
      setState({
        kind: "anonymous",
        message:
          result.status === 401
            ? "That credential was not recognised."
            : `${result.code}: ${result.message}`,
      });
      return;
    }
    setCredential("");
    setState({ kind: "active", session: result.value });
  };

  const onSignOut = async (session: SessionView): Promise<void> => {
    await sessions.signOut(session.csrfToken);
    setState({ kind: "anonymous" });
  };

  if (state.kind === "checking") return <p>Checking your session…</p>;

  if (state.kind === "anonymous") {
    return (
      <main className="mx-auto max-w-md space-y-4 p-6">
        <h1 className="text-2xl font-bold">Forge control plane</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="credential">
              Operator credential
            </label>
            <input
              id="credential"
              type="password"
              autoComplete="off"
              className="mt-1 w-full rounded border p-2 font-mono text-sm"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded border px-3 py-2 text-sm font-medium"
          >
            Sign in
          </button>
        </form>
        {state.message === undefined ? null : (
          <p role="alert" className="font-medium">
            {state.message}
          </p>
        )}
      </main>
    );
  }

  return (
    <>
      <div className="mx-auto flex max-w-5xl items-baseline justify-between gap-3 px-6 pt-6 text-sm">
        <p>
          Signed in as{" "}
          <span className="font-medium">{state.session.subject}</span>
          {state.session.roles.length === 0
            ? " — no roles, so only gates naming nobody"
            : ` — ${state.session.roles.join(", ")}`}
        </p>
        <button
          type="button"
          className="rounded border px-2 py-1 font-medium"
          onClick={() => void onSignOut(state.session)}
        >
          Sign out
        </button>
      </div>
      {children(state.session)}
    </>
  );
}
