import { test, expect, type Page } from '@playwright/test';
import { signIn, selectTenant } from '../fixtures';

const result = {
  id: '11111111-1111-4111-8111-111111111111',
  requestedUrl: 'https://example.com/privacy',
  finalUrl: 'https://example.com/privacy',
  checkedAt: '2026-10-04T00:00:00.000Z',
  status: 'checked',
  bytes: 712,
  contentSha256: 'a'.repeat(64),
  title: 'Privacy notice',
  headings: ['How we use data'],
  publicLinks: [{ label: 'Contact', url: 'https://example.com/contact' }],
  auditPages: [
    {
      kind: 'contact',
      requestedUrl: 'https://example.com/contact',
      status: 'checked',
      finalUrl: 'https://example.com/contact',
      title: 'Contact us',
      contentSha256: 'b'.repeat(64),
    },
  ],
  observations: [
    { kind: 'privacy', status: 'retrieved' },
    { kind: 'contact', status: 'retrieved' },
    { kind: 'terms', status: 'not_linked' },
  ],
};

async function openConnectors(page: Page) {
  // A login redirect can still be committing when this page opens.
  try {
    await page.goto('/connectors', { waitUntil: 'domcontentloaded' });
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.includes('net::ERR_ABORTED')) throw cause;
    await page.waitForLoadState('domcontentloaded');
    await page.goto('/connectors', { waitUntil: 'domcontentloaded' });
  }
}

// The transport response is stubbed here to exercise the page and role flow.
// The live server-side fetch, DNS and redirect boundary are verified by the
// BFF tests; this browser test does not claim external connectivity.
test('owner can audit public content and inspect a recorded result after reload', async ({
  page,
}) => {
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  let submitted = false;
  await page.route('**/api/bff/v1/public-website-checks', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: submitted ? [result] : [] }),
      });
      return;
    }
    submitted = true;
    expect(route.request().headers()['idempotency-key']).toMatch(/[0-9a-f-]{36}/);
    expect(route.request().postDataJSON()).toEqual({ url: result.requestedUrl });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: result }),
    });
  });
  await openConnectors(page);
  let website = page.getByRole('region', { name: 'Public website content audit' });
  await website.getByRole('textbox', { name: 'Public page URL' }).fill(result.requestedUrl);
  await website.getByRole('button', { name: 'Audit public website' }).click();
  await expect(website.getByText('Privacy notice')).toBeVisible();
  await expect(website.getByText('How we use data')).toBeVisible();
  await expect(website.getByText(/Contact: https:\/\/example.com\/contact/)).toBeVisible();
  await expect(website.getByText(/Content SHA-256/)).toBeVisible();
  await expect(website).toContainText('limited public-content audit');
  await expect(website).toContainText('no same-site link found on the starting page');
  expect(submitted).toBe(true);
  await expect(website.getByRole('link', { name: /Contact/ })).toHaveCount(0);
  await page.reload();
  website = page.getByRole('region', { name: 'Public website content audit' });
  await expect(website.getByText('contact · Contact us', { exact: false })).toBeVisible();
});

test('viewer can read history but cannot start a public website check', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.route('**/api/bff/v1/public-website-checks', async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [result] }),
    });
  });
  await openConnectors(page);
  const website = page.getByRole('region', { name: 'Public website content audit' });
  await expect(website.getByText('Privacy notice')).toBeVisible();
  await expect(website.getByRole('button', { name: 'Audit public website' })).toHaveCount(0);
  await expect(website.getByRole('textbox', { name: 'Public page URL' })).toHaveCount(0);
});
