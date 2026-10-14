import { expect, test } from "@playwright/test";
import { TOKEN } from "../playwright.config.js";

/** Projects are built from the UI: found one, edit it, remove it. */
test("operator founds, edits and deletes a project from the UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(".pill.live")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "+ Project" }).click();
  await page.getByPlaceholder("e.g. Billing API").fill("Side Quest");
  await page.getByPlaceholder("/Users/you/src/billing-api").fill("/tmp/side-quest");
  await page.getByLabel("Territory").selectOption("19");
  await page.getByRole("button", { name: "Found project" }).click();

  // the project panel opens on the new project and the map gained a label
  await expect(page.locator(".side-panel h2", { hasText: "Side Quest" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".side-panel")).toContainText("19 hexes");
  await expect(page.locator(".project-label", { hasText: "Side Quest" })).toBeVisible();

  // territory mode shows the banner and can be left again
  await page.getByRole("button", { name: "Edit territory" }).click();
  await expect(page.locator(".mode-banner")).toContainText("Territory mode");
  await page.getByRole("button", { name: "Done editing territory" }).click();
  await expect(page.locator(".mode-banner")).toHaveCount(0);

  // rename
  await page.getByRole("button", { name: "Edit details" }).click();
  const name = page.locator(".side-panel form input").first();
  await name.fill("Side Quest 2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".side-panel h2", { hasText: "Side Quest 2" })).toBeVisible();

  // delete (two-step) and the label disappears
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.locator(".project-label", { hasText: "Side Quest" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
