/**
 * E2E: Public gap-scan flow.
 *
 * Verifies the marketing site funnel:
 *   1. Landing page → free gap-scan
 *   2. Step 1: sector + size
 *   3. Step 2: 12 questions
 *   4. Step 3: contact info
 *   5. Step 4: submit → report
 */

import { test, expect } from '@playwright/test';

import { marketingUrl } from '../target';

test.describe('Public gap-scan funnel', () => {
  test('the marketing site loads with the gap-scan CTA', async ({ page }) => {
    await page.goto(`${marketingUrl}/`);
    await expect(page.getByRole('heading', { name: /Agents do the work/i })).toBeVisible();
    await expect(page.getByText(/Run the free 5-min gap-scan/i)).toBeVisible();
  });

  test('the gap-scan section is reachable', async ({ page }) => {
    await page.goto(`${marketingUrl}/#gap-scan`);
    await expect(page.getByText(/Free 5-minute DPDPA gap-scan/i)).toBeVisible();
  });

  test('the agents page lists all 10 named agents', async ({ page }) => {
    await page.goto(`${marketingUrl}/agents`);
    const agents = [
      'Drishti',
      'Vibhaag',
      'Parikshan',
      'Saakshi',
      'Sudhaar',
      'Karya',
      'Lekha',
      'Nazar',
      'Prativedan',
      'Sanket',
    ];
    for (const name of agents) {
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    }
  });

  test('the contact page loads and sends inquiry successfully', async ({ page }) => {
    await page.goto(`${marketingUrl}/contact`);
    await expect(page.getByRole('heading', { name: /Talk to the founder/i })).toBeVisible();

    await page.locator('#contact-name').fill('Aarav Mehta');
    await page.locator('#contact-email').fill('aarav@fintechbharat.in');
    await page.locator('#contact-company').fill('Fintech Bharat Pvt Ltd');
    await page
      .locator('#contact-message')
      .fill('We require a comprehensive readiness assessment for DPDPA 2023 compliance.');

    await page.getByRole('button', { name: /Send message/i }).click();

    await expect(page.getByText(/Message sent successfully/i)).toBeVisible();
    await expect(page.getByText(/aarav@fintechbharat.in/i)).toBeVisible();
  });
});

test('a complete gap-scan submission persists and refuses another browser', async ({
  page,
  browser,
}) => {
  await page.goto(`${marketingUrl}/gap-scan`);
  await page.getByLabel('Sector', { exact: true }).selectOption('BFSI');
  await page.getByLabel('Employee count', { exact: true }).selectOption('51-200');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const button of await page.getByRole('button', { name: 'No', exact: true }).all())
    await button.click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic Report Owner');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('Company', { exact: true }).fill('Synthetic Company');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const submission = page.waitForResponse(`${marketingUrl}/api/gap-scan`);
  await page.getByRole('button', { name: 'Generate my report', exact: true }).click();
  const res = await submission;
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.accessToken).toBeUndefined();
  expect(body.emailSent).toBe(false);
  await expect(
    page.getByRole('heading', { name: 'Your DPDPA Readiness Report', exact: true }),
  ).toBeVisible();
  const reportUrl = page.url();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Your DPDPA Readiness Report', exact: true }),
  ).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === 'gap_scan_access');
  expect(cookie?.httpOnly).toBe(true);
  const outsider = await browser.newContext();
  try {
    const other = await outsider.newPage();
    expect((await other.goto(reportUrl))?.status()).toBe(404);
    const refused = await outsider.request.post(`${marketingUrl}/api/gap-scan/send-email`, {
      data: { id: body.id, email: 'outsider@example.invalid' },
    });
    expect(refused.status()).toBe(404);
  } finally {
    await outsider.close();
  }
  const owner = await page.request.post(`${marketingUrl}/api/gap-scan/send-email`, {
    data: { id: body.id, email: 'owner@example.invalid' },
  });
  expect(owner.status()).toBe(503);
  expect((await owner.json()).error.code).toBe('delivery_unavailable');
});
