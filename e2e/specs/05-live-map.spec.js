import { test, expect, login, state, markers, shot } from './fixtures.js';

const vehicle = async (page) => (await markers(page)).find((m) => m.label.includes('HR38AB1234'));

test('live map: the vehicle marker appears and moves with polling', async ({ page }) => {
  await login(page, state().admin);
  await page.goto('/live');
  await expect(page.getByRole('heading', { name: 'Live Vehicle Tracking' })).toBeVisible();
  // The simulator picks up today's assignment and reports every 5 s; the marker appears via REST or socket.
  await expect.poll(async () => Boolean(await vehicle(page)), { timeout: 90_000, intervals: [2000] }).toBe(true);
  const first = await vehicle(page);
  await expect.poll(async () => {
    const now = await vehicle(page);
    return now && (now.lat !== first.lat || now.lng !== first.lng);
  }, { timeout: 60_000, intervals: [2000] }).toBe(true); // moved without a page reload (socket deltas)
  await expect(page.getByText(/last update \d+ s ago/)).toBeVisible();
  await page.mouse.click((await vehicle(page)).x, (await vehicle(page)).y);
  await expect(page.getByRole('complementary', { name: 'Vehicle details' })).toContainText('HR38AB1234');
  await shot(page, 'live-map');
});
