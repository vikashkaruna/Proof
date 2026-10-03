import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { selectTenant, signIn, signInFreshAnalyst } from '../fixtures';

async function captureForReview(page: import('@playwright/test').Page, route: string) {
  const directory = process.env.AXIOM_VISUAL_REVIEW_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${route.slice(1)}.png`), fullPage: true });
}

// Exercise the rendered, signed-in routes. A component snapshot alone cannot prove
// that each page actually includes the shared navigation context.
const modules = [
  ['/dashboard', 'Overview', 'P0'],
  ['/discovery', 'Discover & Classify', 'P1'],
  ['/classification', 'Discover & Classify', 'P1'],
  ['/datamap', 'Discover & Classify', 'P1'],
  ['/assessment', 'Assess', 'P0'],
  ['/controls', 'Assess', 'P0'],
  ['/plans', 'Remediate', 'P3'],
  ['/approval', 'Remediate', 'P3'],
  ['/execution', 'Remediate', 'P3'],
  ['/evidence', 'Evidence & Audit', 'P2'],
  ['/dsars', 'Rights & Consent', 'P3'],
  ['/consent', 'Rights & Consent', 'P3'],
  ['/breaches', 'Incident', 'P3'],
  ['/monitoring', 'Monitor', 'P3'],
  ['/regwatch', 'Monitor', 'P2'],
  ['/reports', 'Report', 'P2'],
  ['/connectors', 'Operate', 'P2'],
  ['/policies', 'Operate', 'P4'],
] as const;

test('every owner module route renders its context under a page heading', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'owner');
  await selectTenant(page, 'a');

  for (const [path, section, phase] of modules) {
    await test.step(path, async () => {
      await page.goto(path);
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const context = page.getByTestId('module-bar');
      await expect(context).toBeVisible();
      await expect(context).toContainText(section);
      await expect(context).toContainText(phase);
      if (path === '/datamap') {
        await expect(page.getByRole('link', { name: 'Client Portal ↗' })).toHaveAttribute(
          'href',
          '/portal',
        );
        await expect(page.getByRole('link', { name: 'Audit Ledger ↗' })).toHaveCount(0);
      }
      if (['/dashboard', '/datamap', '/monitoring'].includes(path))
        await captureForReview(page, path);
    });
  }
});

test('internal ledger and workbench routes render their module context', async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydration|server rendered HTML/i.test(message.text()))
      hydrationErrors.push(message.text());
  });
  await signInFreshAnalyst(page, 'module-context');
  await selectTenant(page, 'a');
  for (const [path, section, phase] of [
    ['/ledger', 'Evidence & Audit', 'P2'],
    ['/workbench', 'Operate', 'P0'],
  ] as const) {
    await test.step(path, async () => {
      await page.goto(path);
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const context = page.getByTestId('module-bar');
      await expect(context).toBeVisible();
      await expect(context).toContainText(section);
      await expect(context).toContainText(phase);
      if (path === '/ledger') await captureForReview(page, path);
    });
  }
  expect(hydrationErrors).toEqual([]);
});

test('the partner route renders its own module context', async ({ page }) => {
  await signIn(page, 'partner');
  await selectTenant(page, 'a');
  await page.goto('/partner');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByTestId('module-bar')).toContainText('Operate');
  await expect(page.getByTestId('module-bar')).toContainText('P4');
  await expect(page.getByRole('link', { name: 'Client Portal ↗' })).toHaveAttribute(
    'href',
    '/portal',
  );
  await expect(page.getByRole('link', { name: 'Audit Ledger ↗' })).toHaveCount(0);
  await captureForReview(page, '/partner');
});
