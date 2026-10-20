import { expect, test } from "@playwright/test";
import { drag, openFreshProject, sitePoint } from "./helpers";

test("build a site from scratch, add a rain garden and run it", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openFreshProject(page, request, "e2e-site-start");

  await page.getByRole("button", { name: "Projects" }).click();
  await page.getByRole("menuitem", { name: "New blank site" }).click();
  await expect(page.getByRole("radio", { name: "Site layout" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("tab", { name: "Site", exact: true })).toBeVisible();
  await expect(page.locator(".tab-panel .ok-line")).toBeVisible(); // a blank site is valid as it is

  // Draw a roof and a parking lot over the starting lawn: they replace it, so nothing overlaps.
  await page.keyboard.press("s");
  await page.getByLabel("Surface type").selectOption("roof");
  await drag(page, await sitePoint(page, 5, 5), await sitePoint(page, 45, 35));
  await page.getByLabel("Surface type").selectOption("parking");
  await drag(page, await sitePoint(page, 60, 5), await sitePoint(page, 115, 40));
  await expect(page.locator(".tab-panel .ok-line")).toBeVisible();
  await expect(page.locator("#h-site-inspector")).toContainText("Parking");

  // A drain in the lot, piped to the first drain; the new drain is levelled so the pipe falls.
  await page.keyboard.press("d");
  await page.mouse.click(...await sitePoint(page, 85, 30));
  await page.keyboard.press("c");
  await drag(page, await sitePoint(page, 85, 30), await sitePoint(page, 60, 40));
  await expect(page.locator("#h-site-inspector")).toContainText("C2 · Pipe");
  await expect(page.locator(".tab-panel .ok-line")).toBeVisible(); // no "runs uphill" warning
  await page.keyboard.press("Escape");

  // The lot drains to the nearest drain; point it at the new one.
  await page.locator(".item-row", { hasText: "Parking 1" }).click();
  await page.getByLabel("Drains to").selectOption("I2");
  await page.getByRole("button", { name: "Done" }).click();

  // Undo and redo work for site edits.
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".item-row", { hasText: "Parking 1" })).toContainText("→ I1");
  await page.keyboard.press("Meta+Shift+z");
  await expect(page.locator(".item-row", { hasText: "Parking 1" })).toContainText("→ I2");

  // Back to green infrastructure: a rain garden on the lawn next to the lot.
  await page.getByRole("radio", { name: "Green infrastructure" }).click();
  await page.keyboard.press("r");
  await drag(page, await sitePoint(page, 70, 42), await sitePoint(page, 100, 48));
  await expect(page.locator(".ok-line")).toBeVisible();
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.locator(".impact")).toContainText("less stormwater");

  await page.getByRole("tab", { name: "3D view" }).click();
  await expect(page.locator(".view3d-label.item", { hasText: "RG1" })).toBeVisible();
  expect(errors).toEqual([]);
});
