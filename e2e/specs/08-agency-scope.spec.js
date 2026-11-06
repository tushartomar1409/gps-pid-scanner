import { test, expect, login, state } from './fixtures.js';

test('an agency user sees only its own vehicles and no admin menus', async ({ page }) => {
  const s = state();
  await login(page, s.agencyUser);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Live Tracking' })).toBeVisible();
  for (const hidden of ['Users', 'Detection Settings', 'Activity Logs', 'Report Archive']) { // admin-only items
    await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
  }
  await page.goto('/settings/detection');
  await expect(page.getByText('Access denied')).toBeVisible();
  await page.goto('/live');
  await expect(page.getByText(/^1 vehicles shown/)).toBeVisible(); // HR38AB1234 only; XYZ's HR38XY9999 is out of scope
  await page.getByPlaceholder('Vehicle number').fill('HR38XY9999');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page.getByText('No vehicle matches')).toBeVisible();
});
