import { expect, openUi, test } from "./fixtures.js";

/**
 * The session, end to end (012 §8).
 *
 * Nothing here can be shown in jsdom: the cookie is set by a real
 * `Set-Cookie`, kept by a real cookie jar, attached by the browser to a
 * same-origin request nobody asked it to attach it to, and dropped when the
 * server revokes it. A component test can only assert that the client called
 * `signIn`.
 */

test("a session is established, survives a reload, and is ended by signing out", async ({
  page,
  forge,
}) => {
  // A gate is opened only so that signing in has something to show; the flow
  // under test is the session.
  const gate = await forge.openGate();
  await openUi(page, forge, gate);

  // A credential the provider does not recognise is refused by the real API,
  // and refused *as* a refusal — never as an anonymous caller who is somehow
  // still allowed through to the inbox.
  await forge.signIn(page, { credential: "not-the-operator-secret" });
  await expect(page.getByRole("alert")).toHaveText(
    "That credential was not recognised.",
  );
  await expect(forge.inbox(page)).toHaveCount(0);

  await forge.signIn(page);
  await expect(forge.card(page, gate)).toBeVisible();

  /**
   * Ambient authority is not authority.
   *
   * The browser attaches the session cookie to *any* request to this origin
   * without being asked, so an unsafe one that does not echo the session's
   * CSRF token has to be refused (012 §8). This is the only place that can be
   * shown: it needs a real cookie jar attaching a real cookie to a request the
   * UI's own client did not make.
   */
  const forged = await page.evaluate(
    async ({ runId, approvalId }) =>
      (
        await fetch(`/v1/runs/${runId}/approvals/${approvalId}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    { runId: gate.runId, approvalId: gate.approvalId },
  );
  expect(forged).toBe(401);

  const undecided = await forge.run(gate.runId);
  expect(undecided.status).toBe("AWAITING_APPROVAL");
  expect(undecided.performedEffects).toEqual([]);

  // The reload proves the cookie, and only the cookie: nothing durable is held
  // in the page, so a session that did not survive would mean the form again.
  await page.reload();
  await expect(forge.card(page, gate)).toBeVisible();
  await expect(page.getByLabel("Operator credential")).toHaveCount(0);

  // Sign-out is unsafe and cookie-borne, so it carries the CSRF token like any
  // other unsafe request.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Operator credential")).toBeVisible();

  // Revoked on the server, not merely forgotten by the tab. A reload that came
  // back signed in would mean the session outlived the sign-out.
  await page.reload();
  await expect(page.getByLabel("Operator credential")).toBeVisible();
  await expect(forge.inbox(page)).toHaveCount(0);
});
