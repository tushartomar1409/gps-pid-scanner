import path from 'node:path';
import { test, expect, login, state } from './fixtures.js';
import { ROOT } from '../global-setup.js';

const card = (page, label) => page.locator('div', { has: page.getByText(label, { exact: true }) }).locator('p').nth(1);

test('import the sample CSV through the wizard: validation numbers, then commit', async ({ page }) => {
  await login(page, state().admin);
  await page.goto('/pids/import');
  await page.getByLabel('Import file').setInputFiles(path.join(ROOT, 'workflow-docs', 'samples', 'pids-sample.csv'));
  await page.getByRole('button', { name: 'Validate file' }).click();
  // Numbers from workflow-docs/manual-check-phase2b.md §2 step 12.
  await expect(card(page, 'Total rows')).toHaveText('31');
  await expect(card(page, 'Valid')).toHaveText('26');
  await expect(card(page, 'Errors')).toHaveText('5');
  await expect(card(page, 'Warnings')).toHaveText('5');
  await expect(card(page, 'Duplicates in file')).toHaveText('2');
  await expect(card(page, 'Already in DB')).toHaveText('0');
  await page.getByRole('button', { name: /^Import 26 valid rows$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect(card(page, 'Inserted')).toHaveText('26');
});
