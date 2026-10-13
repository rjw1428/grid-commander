import { devices, expect, test } from "@playwright/test";
import { TOKEN } from "../playwright.config.js";

test.use({ ...devices["Pixel 7"], hasTouch: true, isMobile: true });

test("mobile layout: tab bar, sheet, select a unit and send an order", async ({ page }) => {
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(".pill.live")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".tabbar")).toBeVisible();
  await expect(page.locator(".cmdbar")).toHaveCount(0);
  await page.getByRole("button", { name: /Units/ }).click();
  await expect(page.locator(".sheet.tall")).toBeVisible();
  await page.locator(".sheet .member", { hasText: "web-ui" }).click();
  await expect(page.locator(".sheet:not(.tall)")).toBeVisible();
  await expect(page.locator(".sheet-panel h2")).toHaveText("web-ui");
  await page.getByPlaceholder(/Give an order/).fill("say hello");
  await page.getByRole("button", { name: "Start & send" }).click();
  await expect(page.locator(".sheet-panel .chip.done, .sheet-panel .chip.idle, .sheet-panel .chip.working")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "test-results/mobile.png" });
  // manifest + icons are served
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  const m = await manifest.json();
  expect(m.display).toBe("standalone");
  expect(m.icons.length).toBeGreaterThanOrEqual(2);
  expect((await page.request.get("/icons/icon-512.png")).ok()).toBeTruthy();
  expect((await page.request.get("/sw.js")).ok()).toBeTruthy();
});
