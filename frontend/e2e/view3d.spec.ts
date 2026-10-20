import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { openFreshProject } from "./helpers";

test("3D view shows the site, selects features and replays the storm", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openFreshProject(page, request, "e2e-3d");
  await page.getByRole("tab", { name: "3D view" }).click();
  await expect(page.locator(".view3d-stage canvas")).toBeVisible();
  await expect(page.locator(".view3d-label.item", { hasText: "RG1" })).toBeVisible();

  // Clicking the rain garden selects it, and the selection carries over to the editor.
  const label = (await page.locator(".view3d-label.item", { hasText: "RG1" }).boundingBox())!;
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2 + 8);
  await expect(page.locator(".view3d-tip")).toContainText("Rain garden");
  await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2 + 8);
  await expect(page.locator(".view3d-label.selected")).toHaveText("RG1");

  // Running from the 3D view switches to the storm replay.
  await expect(page.getByRole("button", { name: "Storm replay" })).toBeDisabled();
  await page.getByRole("button", { name: "Run to replay the storm in 3D" }).click();
  await expect(page.getByRole("button", { name: "Storm replay" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  // Sound is off until asked for, and the choice is remembered.
  await page.getByRole("button", { name: "Sound off" }).click();
  await expect(page.getByRole("button", { name: "Sound on" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("runofflab.sound"))).toBe("on");
  const clock = page.locator(".view3d-readout strong");
  const start = await clock.textContent();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(clock).not.toHaveText(start!);
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Sound on" }).click();

  // Record the replay at 3× and get a video file.
  await page.getByRole("button", { name: "3×" }).click();
  const [video] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Record video" }).click(),
  ]);
  expect(video.suggestedFilename()).toMatch(/^runofflab-e2e-3d-D1\.(mp4|webm)$/);
  expect(fs.statSync((await video.path())!).size).toBeGreaterThan(50_000);
  await page.getByRole("button", { name: "Baseline", exact: true }).click();
  await expect(page.locator(".view3d-label.item")).toHaveCount(0); // baseline has no green infrastructure
  await page.getByLabel("X-ray (show pipes)").check();

  // Editing after a run marks the replay as out of date.
  await page.getByRole("tab", { name: "Site editor" }).click();
  await page.keyboard.press("ArrowRight"); // nudges the selected RG1
  await page.getByRole("tab", { name: "3D view" }).click();
  await page.getByRole("button", { name: "Storm replay" }).click();
  await expect(page.locator(".view3d-note")).toContainText("Replaying the design as it was last run");
  expect(errors).toEqual([]);
});
