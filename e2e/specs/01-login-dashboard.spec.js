import { test, expect, login, logout, state } from './fixtures.js';

test('log in, see the dashboard (headline + disclaimer), log out', async ({ page }) => {
  const s = state();
  await login(page, s.admin);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('headline-pct')).toBeVisible();
  await expect(page.getByText('GPS Confirmed Coverage %').first()).toBeVisible();
  await expect(page.getByTestId('gps-disclaimer')).toContainText('does not prove that garbage was collected');
  await expect(page.getByRole('status', { name: /Real-time updates connected/ })).toBeVisible(); // socket through the preview proxy
  await logout(page);
});
