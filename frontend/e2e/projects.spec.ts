import { expect, test } from "@playwright/test";
import { API, openFreshProject, waitForVersion } from "./helpers";

test("edits autosave and survive a reload", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-autosave");
  await page.fill("#design-name", "Renamed in e2e");
  await page.press("#design-name", "Enter");
  await waitForVersion(request, "e2e-autosave", 2);
  await expect(page.locator(".save-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(page.locator(".design-row").filter({ hasText: "Renamed in e2e" })).toBeVisible();
  const saved = await (await request.get(`${API}/projects/e2e-autosave`)).json();
  expect(saved.project.designs[0].name).toBe("Renamed in e2e");
  expect(saved.version).toBe(2);
});

test("projects menu creates, duplicates and deletes projects", async ({ page, request }) => {
  await openFreshProject(page, request, "e2e-menu", "Menu test");
  await page.getByRole("button", { name: "Projects" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.locator(".project-name")).toHaveValue("Menu test (copy)");
  const copyId = new URL(page.url()).searchParams.get("project")!;

  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Projects" }).click();
  await page.getByRole("button", { name: "Delete Menu test (copy)" }).click();
  await expect(page.locator(".project-name")).not.toHaveValue("Menu test (copy)");
  expect((await request.get(`${API}/projects/${copyId}`)).status()).toBe(404);
});

test("a stale tab can't overwrite newer edits", async ({ page, context, request }) => {
  await openFreshProject(page, request, "e2e-conflict");
  const other = await context.newPage();
  await other.goto("/?project=e2e-conflict");
  await other.fill("#design-name", "From tab two");
  await other.press("#design-name", "Enter");
  await waitForVersion(request, "e2e-conflict", 2);

  await page.fill("#design-name", "From tab one");
  await page.press("#design-name", "Enter");
  await expect(page.locator(".banner.conflict")).toBeVisible();
  let saved = await (await request.get(`${API}/projects/e2e-conflict`)).json();
  expect(saved.project.designs[0].name).toBe("From tab two");

  await page.getByRole("button", { name: "Keep mine" }).click();
  await waitForVersion(request, "e2e-conflict", 3);
  saved = await (await request.get(`${API}/projects/e2e-conflict`)).json();
  expect(saved.project.designs[0].name).toBe("From tab one");
});
