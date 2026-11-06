import { test, expect, login, state } from './fixtures.js';

test('create an assignment for today', async ({ page }) => {
  await login(page, state().admin);
  await page.goto('/assignments');
  await page.getByRole('button', { name: 'Create assignment' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Route', { exact: true }).selectOption({ label: 'ROUTE001 — Sector 7 Loop' });
  await dlg.getByLabel('Vehicle', { exact: true }).selectOption({ label: 'HR38AB1234 (Tipper)' });
  await dlg.getByRole('button', { name: 'Create' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('cell', { name: 'ROUTE001' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'HR38AB1234' }).first()).toBeVisible();
});
