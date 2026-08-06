import { expect, openUi, test } from "./fixtures.js";

/**
 * The one thing the UI is for: an operator can see exactly what they are
 * authorising, and can refuse it.
 *
 * Both halves are asserted against the control plane rather than the screen.
 * A card that disappears proves the page re-read the inbox; only the run record
 * proves the effect dispatched, or did not.
 *
 * What is deliberately *not* here: how an already-expired gate is drawn, that
 * an edit authorises nothing, that a rejection needs a reason, how a decided
 * gate reads. Those are pure functions of an `ApprovalView` and a `now`, and
 * the Vitest component suite drives every branch of them faster than a browser
 * can start. The one expiry case below is the one it cannot reach: the clock
 * moving on its own, with no `now` prop to hand it.
 */

test("an approval dispatches the exact effect it named, and nothing else", async ({
  page,
  forge,
}) => {
  const gate = await forge.openGate();
  await openUi(page, forge, gate);
  await forge.signIn(page);

  await expect(
    page.getByText(`Signed in as ${forge.subject} — ${forge.role}`),
  ).toBeVisible();

  // The session is a cookie no script can read. `HttpOnly` is invisible to a
  // jsdom component test — there is no browser there to withhold it — so this
  // is the only place the claim in 012 §8 is actually checked.
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "forge_session",
  );

  const card = forge.card(page, gate);
  // The binding the control plane computed for *this* run, read back off the
  // screen. An operator shown a weaker identifier is not deciding one action.
  await expect(card).toContainText(gate.effectHash);

  await card.getByRole("button", { name: "Approve" }).click();
  await card.getByRole("button", { name: "Yes, authorise slack.post" }).click();

  // The gate leaves the inbox because the inbox was re-read, not because the
  // page guessed what the decision did.
  await expect(card).toHaveCount(0);

  const run = await forge.settled(gate.runId);
  expect(run.status).toBe("SUCCEEDED");
  expect(run.performedEffects).toEqual(["publish"]);

  const decided = await forge.approval(gate.runId, gate.approvalId);
  expect(decided.status).toBe("APPROVED");
  // The principal came from the session the browser holds, never from the body.
  expect(decided.decidedBy).toBe(forge.subject);

  // A real navigation, not a re-render: the cookie still names a live session,
  // and the decision made a moment ago is still made.
  await page.reload();
  await expect(
    page.getByText(`Signed in as ${forge.subject} — ${forge.role}`),
  ).toBeVisible();
  await expect(forge.card(page, gate)).toHaveCount(0);
});

test("a refusal stops the effect", async ({ page, forge }) => {
  const gate = await forge.openGate();
  await openUi(page, forge, gate);
  await forge.signIn(page);

  const card = forge.card(page, gate);
  await card.getByRole("button", { name: "Reject" }).click();
  await card
    .getByLabel("Why are you refusing this?")
    .fill("The copy names a customer.");
  await card.getByRole("button", { name: "Confirm rejection" }).click();

  await expect(card).toHaveCount(0);

  const run = await forge.settled(gate.runId);
  expect(run.performedEffects).toEqual([]);
  expect(run.status).toBe("FAILED");

  const refused = await forge.approval(gate.runId, gate.approvalId);
  expect(refused.status).toBe("REJECTED");
  expect(refused.reason).toBe("The copy names a customer.");
  expect(refused.decidedBy).toBe(forge.subject);
});

test("a gate that runs out of time while it is on screen stops being approvable", async ({
  page,
  forge,
}) => {
  const gate = await forge.openGate();
  await openUi(page, forge, gate);
  await forge.signIn(page);

  const card = forge.card(page, gate);
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();

  /**
   * The clock moves past the gate's deadline and nothing else happens: no
   * click, no reload, no refetch. An expired gate is a timeout rather than a
   * slow yes, so the approve control has to go on its own.
   *
   * The component suite is handed a frozen `now`, so the ticking that makes
   * this true is only exercised by a real clock in a real page.
   */
  await page.clock.setFixedTime(new Date(Date.parse(gate.expiresAt) + 1_000));

  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(card).toContainText("timeout, not a slow yes");
});
