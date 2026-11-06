import { test, expect, login, state, markers, shot } from './fixtures.js';

test('build a route by clicking PIDs on the map and save it', async ({ page }) => {
  const s = state();
  await login(page, s.admin);
  await page.goto('/routes/new');
  await page.getByLabel('Route code').fill('route001');
  await page.getByLabel('Route name').fill('Sector 7 Loop');
  await page.getByLabel('Zone').selectOption({ label: 'NIT Faridabad (NIT)' });
  await page.getByLabel('Ward', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Agency').selectOption({ label: 'ABC Agency' });

  // Ward PIDs load on the canvas map; click 8 of them (markers have no DOM node: use their screen points).
  await expect.poll(async () => (await markers(page)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(10);
  await page.waitForTimeout(800); // fit-bounds animation
  const pts = (await markers(page)).sort((a, b) => a.lng - b.lng || a.lat - b.lat).slice(0, 8);
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  }
  const selected = page.getByRole('list', { name: 'Selected PIDs' }).getByRole('listitem');
  await expect(selected).toHaveCount(8);
  await shot(page, 'route-builder');
  await page.getByRole('button', { name: 'Create route' }).click();
  await expect(page.getByText(/Route ROUTE001 saved with 8 PIDs/)).toBeVisible();
  await expect(page).toHaveURL(/\/routes\/\d+$/);
});
