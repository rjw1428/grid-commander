import { expect, test } from "@playwright/test";
import { TOKEN } from "../playwright.config.js";

/** M4 acceptance: a two-unit session run entirely from the UI, on the demo runtime (FLEET_DEMO=1). */
test("operator runs a two-unit session from the UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(".pill.live")).toBeVisible({ timeout: 15_000 });

  // recruit an Infantry with a first order that needs permission
  await page.getByRole("button", { name: /Recruit/ }).first().click();
  await page.getByPlaceholder("e.g. xre-tests").fill("ui-test");
  await page.getByPlaceholder("What should it do first?").fill("run the tests (needs permission)");
  await page.getByRole("button", { name: "Recruit & start" }).click();

  // it works, then waits for permission → approve with "always allow"
  await expect(page.locator(".side-panel .chip.waiting")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".alert.waiting")).toHaveCount(1);
  await page.getByLabel("always allow this").check();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".side-panel .chip.done, .side-panel .chip.idle")).toBeVisible({ timeout: 15_000 });

  // queue a second order while a long one runs; it auto-submits afterwards
  const box = page.getByPlaceholder(/Give an order|Queue the next order/);
  await box.fill("a long task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".side-panel .chip.working")).toBeVisible({ timeout: 10_000 });
  await box.fill("second order");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator(".queued-text")).toHaveText("second order");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.locator(".queued-text")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".side-panel .chip.done, .side-panel .chip.idle")).toBeVisible({ timeout: 20_000 });

  // transcript shows the turns
  await page.getByRole("tab", { name: "transcript" }).click();
  await expect(page.locator(".te.user").first()).toBeVisible();
  await expect(page.locator(".te.result").first()).toBeVisible();

  // group with another unit into a team and broadcast
  await page.locator(".tray-card", { hasText: "web-ui" }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".side-panel h2")).toHaveText("2 units selected");
  await page.getByPlaceholder("team name").fill("UI Squad");
  await page.getByRole("button", { name: "Group into team" }).click();
  await expect(page.locator(".side-panel .chip", { hasText: "UI Squad" })).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Order for every selected unit…").fill("broadcast hello");
  await page.getByRole("button", { name: "Broadcast", exact: true }).click();
  await expect(page.locator(".toast.ok", { hasText: /Sent|queued/ })).toBeVisible();
  await expect(page.locator(".tray-card.team", { hasText: "UI Squad" })).toBeVisible();

  // alerts: a done alert exists and can be dismissed from the stack
  await expect(page.locator(".alert.done").first()).toBeVisible({ timeout: 20_000 });
  const before = await page.locator(".alert").count();
  await page.locator(".alert .alert-x").first().click();
  await expect(page.locator(".alert")).toHaveCount(before - 1);

  expect(errors).toEqual([]);
});
