import { test, expect, login, state, markers, shot, apiAs } from './fixtures.js';

const NOT_VISITED = '#D55E00';
const VISITED = ['#009E73', '#E6B800']; // confirmed, candidate (fe/src/utils/visitStatus.js)

test('coverage map: a PID changes colour as the vehicle passes; legend; evidence drawer', async ({ page }) => {
  const s = state();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [asg] = await apiAs(s.admin, 'GET', `/route-assignments?operational_date=${today}&limit=10`);
  await login(page, s.admin);
  await page.goto(`/coverage?date=${today}&assignment=${asg.id}`);
  await expect(page.getByLabel('Coverage legend')).toBeVisible();
  await expect(page.getByLabel('Coverage legend')).toContainText('does not prove that garbage was collected');
  for (const label of ['GPS Visit Confirmed', 'GPS Visit Candidate', 'Not Visited', 'GPS Data Unavailable', 'Actual GPS trail', 'Current vehicle location']) {
    await expect(page.getByLabel('Coverage legend')).toContainText(label);
  }
  const pidMarkers = async () => (await markers(page)).filter((m) => /^.+ · /.test(m.label) && !m.label.includes('HR38'));
  await expect.poll(async () => (await pidMarkers()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
  expect((await pidMarkers()).some((m) => m.fill === NOT_VISITED)).toBe(true);
  // Within N poll cycles (5 s each) detection recolours at least one PID IN PLACE (pid:status over the socket).
  await expect.poll(async () => (await pidMarkers()).filter((m) => VISITED.includes(m.fill)).length, { timeout: 150_000, intervals: [3000] }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const hit = (await pidMarkers()).find((m) => VISITED.includes(m.fill));
  await page.mouse.click(hit.x, hit.y);
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('GPS evidence');
  await expect(drawer.getByRole('list', { name: 'Evidence list' })).toContainText(/GPS point within [\d.]+ m|Track passed nearby \(between two GPS points\)/);
  await expect(drawer).toContainText('does not prove');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByLabel('Route comparison')).toContainText('GPS route distance');
  await shot(page, 'coverage-map');
});
