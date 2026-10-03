import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { signIn, selectTenant } from '../fixtures';
import { repoRoot } from '../target';

/** Explicit live-site journey; excluded from ordinary CI and container parity. */
test('owner audits axiomminds.ai, reloads persisted evidence, and viewer reads it', async ({
  page,
  browser,
}) => {
  const reviewDir = resolve(repoRoot, '.axiom-runtime/review/public-website');
  mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/connectors');
  const website = page.getByRole('region', { name: 'Public website content audit' });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/bff/v1/public-website-checks') &&
      response.request().method() === 'POST',
  );
  await website.getByRole('textbox', { name: 'Public page URL' }).fill('https://axiomminds.ai');
  await website.getByRole('button', { name: 'Audit public website' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as {
    data: {
      id: string;
      finalUrl: string;
      title: string;
      auditPages: { kind: string; status: string; finalUrl?: string; contentSha256?: string }[];
      observations: { kind: string; status: string }[];
    };
  };
  expect(payload.data.finalUrl).toBe('https://axiomminds.ai/');
  expect(payload.data.auditPages.map((entry) => [entry.kind, entry.status])).toEqual([
    ['privacy', 'checked'],
    ['contact', 'checked'],
    ['terms', 'checked'],
  ]);
  expect(
    payload.data.auditPages.every((entry) => /^[a-f0-9]{64}$/.test(entry.contentSha256 ?? '')),
  ).toBe(true);
  expect(payload.data.observations.every((entry) => entry.status === 'retrieved')).toBe(true);
  await expect(website.getByText(payload.data.title).first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(reviewDir, 'owner-audit.png'), fullPage: true });
  writeFileSync(
    resolve(reviewDir, 'axiomminds-audit.json'),
    JSON.stringify(payload.data, null, 2),
    { mode: 0o600 },
  );

  await page.reload();
  const persisted = page.getByRole('region', { name: 'Public website content audit' });
  await expect(persisted.getByText(payload.data.title).first()).toBeVisible();
  await expect(persisted).toContainText('Privacy policy | Axiom Minds');
  await expect(persisted).toContainText('Contact | Axiom Minds');
  await expect(persisted).toContainText('Terms of service | Axiom Minds');
  const refusalPromise = page.waitForResponse(
    (candidate) =>
      candidate.url().includes('/api/bff/v1/public-website-checks') &&
      candidate.request().method() === 'POST',
  );
  await persisted.getByRole('textbox', { name: 'Public page URL' }).fill('http://127.0.0.1/');
  await persisted.getByRole('button', { name: 'Audit public website' }).click();
  const refusal = await refusalPromise;
  expect(refusal.status()).toBe(400);
  expect((await refusal.json()) as unknown).toEqual({ error: { code: 'invalid_url' } });
  await expect(persisted.getByText('Enter a valid public HTTP or HTTPS URL.')).toBeVisible();
  writeFileSync(
    resolve(reviewDir, 'refusal.json'),
    JSON.stringify({ target: 'http://127.0.0.1/', status: refusal.status(), code: 'invalid_url' }),
    { mode: 0o600 },
  );

  const viewerPage = await browser.newPage();
  try {
    await signIn(viewerPage, 'viewer');
    await selectTenant(viewerPage, 'a');
    await viewerPage.goto('/connectors');
    const viewerAudit = viewerPage.getByRole('region', { name: 'Public website content audit' });
    await expect(viewerAudit.getByText(payload.data.title).first()).toBeVisible();
    await expect(viewerAudit.getByRole('button', { name: 'Audit public website' })).toHaveCount(0);
    await viewerPage.evaluate(() => window.scrollTo(0, 0));
    await viewerPage.screenshot({ path: resolve(reviewDir, 'viewer-audit.png'), fullPage: true });
  } finally {
    await viewerPage.close();
  }
});
