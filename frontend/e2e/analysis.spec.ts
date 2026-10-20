import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { openFreshProject } from "./helpers";

test("Design Explorer finds layouts and one can be adopted and run", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-explorer");
  await page.getByRole("tab", { name: "Design Explorer" }).click();
  await page.getByRole("button", { name: "100" }).click();
  await page.getByRole("button", { name: "Explore designs" }).click();
  await expect(page.getByRole("button", { name: "Explore again" })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".explorer .meter")).toContainText("100 / 100 designs");
  await expect(page.locator("#h-selected")).toContainText("Best trade-off");

  await page.getByRole("button", { name: "Add to my designs" }).click();
  await expect(page.locator(".design-row[aria-current=true]")).toContainText("Explorer:");
  await expect(page.locator(".ok-line")).toBeVisible(); // adopted designs pass every check
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.locator(".impact")).toContainText("less stormwater");
});

test("playback, what-if and the PDF report", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-results");
  await page.getByRole("button", { name: "Run comparison" }).click();

  const clock = page.locator(".playback-clock strong");
  const start = await clock.textContent();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(clock).not.toHaveText(start!);
  await page.getByRole("button", { name: "Pause" }).click();

  await page.getByRole("button", { name: "Stress-test this design" }).click();
  await expect(page.locator(".card:has(#h-whatif) tbody tr")).toHaveCount(7);
  await expect(page.locator(".card:has(#h-whatif) .whatif-summary")).toContainText("Runoff reduction ranges from");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PDF report" }).click()]);
  expect(download.suggestedFilename()).toBe("runofflab-e2e-results-D1.pdf");
  const pdf = fs.readFileSync((await download.path())!);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(10_000);
});

test("compare all designs ranks them and opens one", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-compare");
  await page.getByRole("button", { name: "Duplicate" }).click(); // a second design to rank
  await page.getByRole("button", { name: "Run comparison" }).click();
  const card = page.getByRole("region", { name: "Compare designs" });
  await card.getByRole("button", { name: "Compare all designs" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(3); // baseline + two designs
  await expect(card.locator(".whatif-summary")).toContainText("best value");
  await expect(card.locator(".badge.good")).toHaveCount(1);
  await card.getByRole("button", { name: "Add a year of rainfall" }).click();
  await expect(card.locator("th", { hasText: "Kept on site, year" })).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("tbody tr").first()).toContainText("45 %"); // the baseline keeps 45 % of the synthetic year
  await expect(card.locator("tbody tr").nth(1)).toContainText("63 %");
  await card.getByRole("button", { name: "Open" }).first().click();
  await expect(page.locator(".design-row[aria-current=true]")).toBeVisible();
});

test("year-long simulation with the synthetic year and an imported record", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-year");
  await page.getByRole("button", { name: "Run comparison" }).click();
  const card = page.getByRole("region", { name: "Over a whole year" });
  await card.getByRole("button", { name: "Run year-long simulation" }).click();
  await expect(card.locator(".whatif-summary")).toContainText("In 1,000 mm of rain over 366 days");
  await expect(card.locator(".whatif-summary")).toContainText("less runoff a year");
  await expect(card.locator(".year-kpi").first()).toContainText("Rain kept on site");
  await card.getByRole("button", { name: "Table" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(12);

  // Two days of hourly readings with one 20 mm storm.
  const rows = ["time,mm", ...Array.from({ length: 48 }, (_, h) =>
    `2023-07-${String(1 + Math.floor(h / 24)).padStart(2, "0")} ${String(h % 24).padStart(2, "0")}:00,${h >= 5 && h < 9 ? 5 : 0}`)];
  await page.getByRole("tab", { name: /Storm & soil/ }).click();
  await page.getByRole("radio", { name: "Imported record" }).click();
  await page.getByLabel("Rainfall CSV file").setInputFiles({ name: "station.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) });
  await expect(page.locator(".tab-panel")).toContainText("Total rain20 mm");
  await expect(card.locator(".stale-note")).toBeVisible();
  await card.getByRole("button", { name: "Run again" }).click();
  await expect(card.locator(".whatif-summary")).toContainText("In 20 mm of rain over 2 days");
  await expect(card.locator(".whatif-summary")).toContainText("over these 2 days");
});
