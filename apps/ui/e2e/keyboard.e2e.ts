import { expect, openUi, test } from "./fixtures.js";

/**
 * 012 §11.5: the queue can be worked without a mouse.
 *
 * The component suite fires `j` and `a` at the list item directly, which shows
 * the handler is right and nothing else. What only a browser can show is that
 * an operator can *reach* the queue by tabbing, that `j` really moves focus,
 * and — the assertion that makes this test worth its cost — that the gate which
 * dispatched is the one focus had moved to, not the one it started on.
 */

test("two keystrokes move to the second gate and authorise that one", async ({
  page,
  forge,
}) => {
  const first = await forge.openGate();
  const second = await forge.openGate();

  await openUi(page, forge, first);
  await forge.signIn(page);

  const items = forge.inbox(page).getByRole("listitem");
  await expect(items).toHaveCount(2);

  // Which gate is drawn second is the control plane's business — the inbox is
  // ordered by expiry. Read it off the page rather than assuming.
  const secondText = await items.nth(1).innerText();
  const focused = secondText.includes(second.runId) ? second : first;
  const untouched = focused === second ? first : second;

  // Reachable by Tab. The list items themselves are `tabIndex={-1}`, so the
  // first keyboard landing inside the queue is a card's own button.
  const approveOnFirst = items.nth(0).getByRole("button", { name: "Approve" });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (
      await approveOnFirst.evaluate((node) => node === document.activeElement)
    )
      break;
    await page.keyboard.press("Tab");
  }
  await expect(approveOnFirst).toBeFocused();

  await page.keyboard.press("j");
  await expect(items.nth(1)).toBeFocused();

  // `a` opens the confirmation. It never submits: an approval dispatches an
  // effect, so one keystroke may not be the whole of a decision.
  await page.keyboard.press("a");
  const confirm = items
    .nth(1)
    .getByRole("button", { name: "Yes, authorise slack.post" });
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(items).toHaveCount(1);

  const dispatched = await forge.settled(focused.runId);
  expect(dispatched.status).toBe("SUCCEEDED");
  expect(dispatched.performedEffects).toEqual(["publish"]);

  // The gate focus left behind is untouched. Without this, a shortcut that
  // decided whichever gate was first would pass the test above.
  const other = await forge.run(untouched.runId);
  expect(other.status).toBe("AWAITING_APPROVAL");
  expect(other.performedEffects).toEqual([]);
});
