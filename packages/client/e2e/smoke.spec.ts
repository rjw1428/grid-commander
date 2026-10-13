import { expect, test } from "@playwright/test";
import { TOKEN } from "../playwright.config.js";

test("map renders every unit from fleet.example.json", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(".pill.live")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator("[data-unit-label]")).toHaveCount(14);
  await expect(page.locator(".project-label")).toHaveCount(4);
  await expect(page.locator(".tray-card")).toHaveCount(15); // 1 team + 14 units
  await page.waitForTimeout(1500); // let the camera settle and rigs animate a few frames
  await page.screenshot({ path: "test-results/map.png" });
  await page.getByRole("button", { name: "Legend" }).click();
  await expect(page.locator(".legend-row")).toHaveCount(6);
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});
