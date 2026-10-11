import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createMfaAccount, selectTenant, signIn, signInAs } from '../fixtures';
import { repoRoot } from '../target';

const routes = [
  '/estate',
  '/plans',
  '/approval',
  '/execution',
  '/evidence',
  '/dsars',
  '/consent',
  '/breaches',
  '/monitoring',
  '/regwatch',
  '/reports',
  '/reports?tab=pramaan',
  '/connectors',
  '/policies',
] as const;

test('module pages and report views use the branded header with one accessible page title', async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const account = await createMfaAccount('header-review', { role: 'admin' });
  await signInAs(page, account.email, account.password);
  await selectTenant(page, 'a');

  await page.goto('/controls');
  const reference = page.locator('[class*="bg-gradient-to-br"]').filter({
    has: page.getByRole('heading', { level: 1, name: 'Control Library' }),
  });
  const referenceGradient = await reference.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  expect(referenceGradient).toContain('gradient');

  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.status(), `${route} navigation response`).toBe(200);
    await expect(page).toHaveURL(new RegExp(route.split('?')[0]!));
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading, route).toHaveCount(1);
    const header = page.locator('header').filter({ has: heading });
    await expect(header, route).toBeVisible();
    await expect
      .poll(async () => header.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toBe(referenceGradient);
    await expect(header.getByTestId('module-bar'), route).toBeVisible();
    await expect(header.getByTestId('module-bar'), route).toContainText(/P[0-5]/);
    await expect(header.locator('[lang="hi"]'), route).toBeVisible();
  }

  await page.goto('/reports?tab=pramaan');
  await expect(page.getByTestId('related-agents')).toContainText('pramaan');
  await page.getByRole('button', { name: 'Working reports and registers' }).click();
  await expect(page).toHaveURL(/\/reports(?:$|\?)/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Working Reports & Registers' }),
  ).toBeVisible();
  await expect(page.getByTestId('related-agents')).toContainText('prativedan');
  await page.getByRole('button', { name: 'Closure dossiers' }).click();
  await expect(page).toHaveURL(/\/reports\?tab=pramaan/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Statutory Proof Dossiers' }),
  ).toBeVisible();
  await expect(page.getByTestId('related-agents')).toContainText('pramaan');

  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const route of [
    '/dashboard',
    '/assessment',
    '/estate',
    '/plans',
    '/approval',
    '/execution',
    '/evidence',
    '/connectors',
    '/settings',
    '/settings/members',
    '/settings/security',
    '/dsars',
    '/consent',
    '/breaches',
    '/monitoring',
    '/regwatch',
    '/reports',
    '/reports?tab=pramaan',
    '/policies',
    '/portal',
  ]) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }), `${route} page title`).toBeVisible();
    const frame = await page
      .locator('main')
      .first()
      .evaluate((main) => {
        const child = main.firstElementChild;
        if (!child) return null;
        const content = main.getBoundingClientRect();
        const page = child.getBoundingClientRect();
        const style = getComputedStyle(main);
        return {
          contentWidth:
            content.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          contentLeft: content.left + parseFloat(style.paddingLeft),
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
          pageWidth: page.width,
          pageLeft: page.left,
        };
      });
    expect(frame, `${route} has a page frame`).not.toBeNull();
    // 20px at desktop width (xl:px-5): the content gutter was tightened from 24px.
    expect(frame!.paddingLeft, `${route} reduced left margin`).toBe(20);
    expect(frame!.paddingRight, `${route} reduced right margin`).toBe(20);
    expect(frame!.pageWidth, `${route} fills the content width`).toBeGreaterThanOrEqual(
      frame!.contentWidth - 2,
    );
    expect(Math.abs(frame!.pageLeft - frame!.contentLeft), `${route} left margin`).toBeLessThan(2);
    if (route === '/regwatch' && process.env.AXIOM_LAYOUT_REVIEW === 'true') {
      const reviewDir = resolve(repoRoot, '.axiom-runtime/review/layout');
      mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
      await page.screenshot({ path: resolve(reviewDir, 'regwatch-desktop.png'), fullPage: false });
    }
  }

  await page.goto('/assessment');
  const heading = page.getByRole('heading', { level: 1, name: 'Assessment', exact: true });
  const provenance = page.getByTestId('assessment-provenance');
  await expect(provenance).toBeVisible();
  const headerBeforeStatus = await heading.evaluate((element) => {
    const status = document.querySelector('[data-testid="assessment-provenance"]');
    return Boolean(
      status && element.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(headerBeforeStatus).toBe(true);
  if (process.env.AXIOM_LAYOUT_REVIEW === 'true') {
    const reviewDir = resolve(repoRoot, '.axiom-runtime/review/layout');
    mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: resolve(reviewDir, 'assessment-desktop.png'), fullPage: true });
    await page.screenshot({ path: resolve(reviewDir, 'assessment-desktop-viewport.png') });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePadding = await page
    .locator('main')
    .first()
    .evaluate((main) => {
      const style = getComputedStyle(main);
      return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
    });
  expect(mobilePadding).toEqual([12, 12]);
  for (const route of ['/estate', '/breaches', '/consent', '/reports?tab=pramaan']) {
    await page.goto(route);
    const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
    await expect(header, `${route} at mobile width`).toBeVisible();
    expect(
      await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      `${route} header content fits mobile width`,
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `${route} keeps horizontal scrolling inside its content`,
    ).toBe(true);
  }
  await page.goto('/assessment');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Assessment', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  if (process.env.AXIOM_LAYOUT_REVIEW === 'true') {
    await page.screenshot({
      path: resolve(repoRoot, '.axiom-runtime/review/layout/assessment-mobile.png'),
      fullPage: false,
    });
  }
});

test('generic module pages fill desktop width and fit a narrow mobile viewport', async ({
  page,
}) => {
  test.setTimeout(2 * 60_000);
  await signIn(page, 'reviewer');
  await selectTenant(page, 'a');
  for (const width of [1920, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/controls', '/discovery', '/classification', '/datamap', '/partner']) {
      await page.goto(route);
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading, `${route} title at ${width}px`).toBeVisible();
      const frame = await page
        .locator('main')
        .first()
        .evaluate((main) => {
          const child = main.firstElementChild;
          if (!child) return null;
          const content = main.getBoundingClientRect();
          const page = child.getBoundingClientRect();
          const style = getComputedStyle(main);
          return {
            availableWidth:
              content.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            contentLeft: content.left + parseFloat(style.paddingLeft),
            width: page.width,
            left: page.left,
          };
        });
      expect(frame, `${route} frame at ${width}px`).not.toBeNull();
      expect(frame!.width, `${route} fills available width at ${width}px`).toBeGreaterThanOrEqual(
        frame!.availableWidth - 2,
      );
      expect(
        Math.abs(frame!.left - frame!.contentLeft),
        `${route} aligns at ${width}px`,
      ).toBeLessThan(2);
      const banner = page.locator('[class*="bg-gradient-to-br"]').filter({ has: heading });
      expect(
        await banner.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        `${route} banner fits at ${width}px`,
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `${route} stays inside the ${width}px viewport`,
      ).toBe(true);
    }
  }
});

test('settings keeps long account identities readable without horizontal page scrolling', async ({
  page,
}) => {
  const account = await createMfaAccount('long-organization-operator-layout-verification', {
    role: 'admin',
  });
  await signInAs(page, account.email, account.password);
  await selectTenant(page, 'a');
  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings', exact: true }),
  ).toBeVisible();
  const email = page.getByText(account.email, { exact: true });
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(email, `complete account email at ${width}px`).toBeVisible();
    const layout = await email.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        left: bounds.left,
        right: bounds.right,
        contentFits: element.scrollWidth <= element.clientWidth + 1,
        clipped: ['hidden', 'clip'].includes(style.overflowX),
      };
    });
    expect(layout.pageWidth, `settings fits the ${width}px viewport`).toBeLessThanOrEqual(
      layout.viewportWidth + 1,
    );
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.contentFits, `complete email fits its cell at ${width}px`).toBe(true);
    expect(layout.clipped, `email is not hidden at ${width}px`).toBe(false);
  }
});
