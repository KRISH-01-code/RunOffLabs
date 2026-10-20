import { expect, test } from "@playwright/test";
import { drag, openFreshProject, sitePoint } from "./helpers";

test("the sample design reproduces the reference SWMM result", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-reference");
  await page.getByRole("button", { name: "Run comparison" }).click();
  const tiles = page.locator(".kpi");
  await expect(tiles.nth(0)).toContainText("576 m³");
  await expect(tiles.nth(0)).toContainText("Baseline 826 m³");
  await expect(tiles.nth(1)).toContainText("0.291 m³/s");
  await expect(page.locator(".impact")).toContainText("250 m³ less stormwater");
  const quality = page.getByRole("region", { name: "Water quality" });
  await expect(quality).toContainText("removes 44 % of the sediment");
  await expect(quality).toContainText("short of the 80 %");
  await expect(quality.locator("tbody tr").first()).toContainText("54.4 kg");
});

test("drawing, checking, moving and undoing a rain garden", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-draw");
  await page.keyboard.press("r");
  await drag(page, await sitePoint(page, 10, 100), await sitePoint(page, 30, 106));

  await expect(page.locator("#h-inspector")).toContainText("RG2");
  const box = page.locator(".grid-4 input");
  await expect(box.nth(2)).toHaveValue("20"); // width
  await expect(box.nth(3)).toHaveValue("6"); // height
  // 120 m² more of rain garden pushes the sample over its $250,000 budget.
  await expect(page.locator(".issue.error").filter({ hasText: "exceeds the budget" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run comparison" })).toBeDisabled();

  await drag(page, await sitePoint(page, 20, 103), await sitePoint(page, 25, 108));
  await expect(box.nth(0)).toHaveValue("15");
  await expect(box.nth(1)).toHaveValue("105");

  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await expect(page.locator("#h-inspector")).toHaveCount(0);
  await expect(page.locator(".ok-line")).toBeVisible();
});

test("drawing on the wrong surface is flagged", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-wrong-host");
  await page.keyboard.press("p"); // permeable pavement belongs on parking, not a lawn
  await drag(page, await sitePoint(page, 10, 100), await sitePoint(page, 20, 110));
  const errors = page.locator(".issue.error");
  await expect(errors.filter({ hasText: "allowed: parking, sidewalk" })).toBeVisible();
  await expect(errors.filter({ hasText: "exceeds the budget" })).toBeVisible(); // 100 m² of pavers tips it over
});

test("green roof, infiltration trench and cistern can be drawn, checked and simulated", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-lids");
  await page.getByRole("button", { name: "New", exact: true }).click(); // an empty design, within budget
  await page.keyboard.press("g");
  await drag(page, await sitePoint(page, 8, 8), await sitePoint(page, 40, 36));
  await expect(page.locator("#h-inspector")).toContainText("GR1 · Green roof");
  await page.keyboard.press("t");
  await drag(page, await sitePoint(page, 150, 76), await sitePoint(page, 190, 79));
  await expect(page.locator("#h-inspector")).toContainText("IT1 · Infiltration trench");
  await page.keyboard.press("b");
  await drag(page, await sitePoint(page, 3, 52), await sitePoint(page, 6, 55));
  await expect(page.locator("#h-inspector")).toContainText("RB1 · Rain barrel / cistern");
  await expect(page.locator(".tab-panel")).toContainText("Tank holds 10.8 m³, full after 25.0 mm of rain on that roof");
  await expect(page.locator(".ok-line")).toBeVisible();

  // A green roof on a lawn is refused.
  await page.keyboard.press("g");
  await drag(page, await sitePoint(page, 10, 80), await sitePoint(page, 20, 90));
  await expect(page.locator(".issue.error")).toContainText("GR2 is on West lawn");
  await page.keyboard.press("Delete");
  await expect(page.locator(".ok-line")).toBeVisible();

  await page.getByRole("button", { name: "Run comparison" }).click();
  const lids = page.locator(".card", { hasText: "Green infrastructure performance" }).locator("tbody tr");
  await expect(lids).toHaveCount(3);
  await expect(lids.nth(0)).toContainText("Green roof");
  await expect(lids.nth(2)).toContainText("1,200 mm"); // the cistern ends the storm full
  await expect(page.locator(".impact")).toContainText("less stormwater");
});
