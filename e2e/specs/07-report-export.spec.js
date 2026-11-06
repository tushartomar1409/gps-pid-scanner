import { test, expect, login, state, shot } from './fixtures.js';

test('export the daily coverage report as XLSX under the server filename; screenshots', async ({ page }) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  await login(page, state().admin);
  await page.goto(`/reports/daily-coverage?date=${today}`);
  await expect(page.getByRole('heading', { name: 'Daily PID Coverage' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ROUTE001' }).first()).toBeVisible();
  await expect(page.getByTestId('gps-disclaimer')).toBeVisible();
  await shot(page, 'report-daily-coverage');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Excel' }).click()]);
  expect(dl.suggestedFilename()).toBe(`daily-coverage_${today}_all.xlsx`);
  const file = await dl.path();
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK'); // a real xlsx (zip) file

  // Dashboard with data + history playback, for the screenshot set.
  await page.goto('/');
  await expect(page.getByTestId('headline-pct')).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, 'dashboard');
  const s = state();
  await page.goto(`/history?vehicle_id=${s.vehicles.v1.id}&date=${today}`);
  await page.getByRole('button', { name: 'Show track' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '60×' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(1500);
  await shot(page, 'history');
});
