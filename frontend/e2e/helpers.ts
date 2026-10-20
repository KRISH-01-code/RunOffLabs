import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API = "http://127.0.0.1:8100/api";

/** Create a fresh copy of the sample project and open it. Returns its id. */
export async function openFreshProject(page: Page, request: APIRequestContext, id: string, name = id) {
  const sample = await (await request.get(`${API}/sample`)).json();
  await request.delete(`${API}/projects/${id}`);
  const r = await request.post(`${API}/projects`, { data: { ...sample, id, name } });
  expect(r.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem("runofflab.gettingStarted.dismissed", "1"));
  await page.goto(`/?project=${id}`);
  await expect(page.locator(".ok-line")).toBeVisible();
  return id;
}

/** Convert site metres to page pixels on the editor canvas. */
export async function sitePoint(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => {
    const svg = document.querySelector(".editor-canvas svg") as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const p = pt.matrixTransform(svg.getScreenCTM()!);
    return [p.x, p.y] as [number, number];
  }, [x, y]);
}

export async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

/** Wait until the backend holds `version` of a project (autosave is debounced). */
export async function waitForVersion(request: APIRequestContext, id: string, version: number) {
  await expect.poll(async () => (await (await request.get(`${API}/projects/${id}`)).json()).version).toBe(version);
}
