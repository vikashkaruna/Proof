import { test, expect, type Page } from '@playwright/test';
import { selectTenant, signIn, satisfyLoginMfa, state } from '../fixtures';
import { webOrigin } from '../target';

const endpoint = '/api/bff/v1/classification/reviews';
const historyName = 'Recorded human classification reviews';

/**
 * Real Auth → browser/BFF bridge → human_action_writer RPC → RLS page read.
 * The values below are explicitly human-declared test records. This journey
 * does not represent a website scan, agent observation or applied correction.
 */
test('saved human classification reviews survive reload with viewer and tenant boundaries', async ({
  browser,
}, testInfo) => {
  const ownerContext = await browser.newContext({ baseURL: webOrigin });
  const foreignContext = await browser.newContext({ baseURL: webOrigin });
  const viewerContext = await browser.newContext({ baseURL: webOrigin });
  const owner = await ownerContext.newPage();
  const foreign = await foreignContext.newPage();
  const viewer = await viewerContext.newPage();
  const suffix = crypto.randomUUID();
  const declaration = {
    systemId: `human-declared-browser-test-${suffix}`,
    resourcePath: 'manual-test-declaration.contact-label',
    sensitivityLevel: 'public',
    detectedCategories: ['human-declared-test-label'],
    confidenceScore: 0,
    decision: 'adjusted',
    adjustedSensitivity: 'internal',
    justification:
      'Human-declared browser test only; no source scan or system correction occurred.',
  };
  const foreignDeclaration = {
    ...declaration,
    systemId: `foreign-human-declaration-${suffix}`,
    decision: 'confirmed',
    adjustedSensitivity: null,
  };
  const rejectedDeclaration = {
    ...declaration,
    systemId: `refused-viewer-declaration-${suffix}`,
  };

  async function recordReview(page: Page, body: typeof declaration | typeof foreignDeclaration) {
    const response = await page.request.post(endpoint, { data: body });
    expect(response.status()).toBe(201);
    const recorded = (await response.json()) as { reviewId: string; decision: string };
    expect(recorded.reviewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded.decision).toBe(body.decision);
    return recorded.reviewId;
  }

  try {
    await signIn(owner, 'owner');
    await selectTenant(owner, 'a');
    const reviewId = await recordReview(owner, declaration);

    // The sanctioned founder fixture belongs to both tenants. Its real MFA
    // attestation is completed for B; no membership or source rows are seeded.
    await signIn(foreign, 'founder');
    await selectTenant(foreign, 'b');
    await satisfyLoginMfa(foreign, 'founder');
    const foreignId = await recordReview(foreign, foreignDeclaration);

    await signIn(viewer, 'viewer');
    await selectTenant(viewer, 'a');
    const refusal = await viewer.request.post(endpoint, { data: rejectedDeclaration });
    expect(refusal.status()).toBe(403);
    const foreignRead = await viewer.request.get(endpoint, {
      headers: { 'X-Tenant-Id': state.tenantB.id },
    });
    expect(foreignRead.status()).toBe(403);

    const saved = await viewer.request.get(endpoint);
    expect(saved.status()).toBe(200);
    const { reviews } = (await saved.json()) as {
      reviews: {
        id: string;
        tenant_id: string;
        system_id: string;
        reviewed_by: string;
        decision: string;
        confidence_score: number;
        adjusted_sensitivity: string | null;
        justification: string;
      }[];
    };
    expect(reviews.find((review) => review.id === reviewId)).toMatchObject({
      tenant_id: state.tenantA.id,
      system_id: declaration.systemId,
      reviewed_by: state.accounts.owner.id,
      decision: 'adjusted',
      confidence_score: 0,
      adjusted_sensitivity: 'internal',
      justification: declaration.justification,
    });
    expect(reviews.every((review) => review.tenant_id === state.tenantA.id)).toBe(true);
    expect(reviews.some((review) => review.id === foreignId)).toBe(false);
    expect(reviews.some((review) => review.system_id === rejectedDeclaration.systemId)).toBe(false);

    await viewer.goto('/classification');
    for (let visit = 0; visit < 2; visit++) {
      if (visit === 1) await viewer.reload();
      const history = viewer.getByRole('region', { name: historyName });
      const row = history.locator('li').filter({ hasText: declaration.systemId });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(declaration.resourcePath);
      await expect(row).toContainText(declaration.justification);
      await expect(row).toContainText(`Review ID: ${reviewId}`);
      await expect(row).toContainText('Original sensitivity (declared)');
      await expect(row).toContainText('Adjusted sensitivity (recorded)');
      await expect(row.getByText('public', { exact: true })).toBeVisible();
      await expect(row.getByText('internal', { exact: true })).toBeVisible();
      await expect(row.getByText('0%', { exact: true })).toBeVisible();
      await expect(history).toContainText('source verification are not recorded');
      await expect(history).toContainText('They do not prove that a system was scanned');
      await expect(history.getByRole('button')).toHaveCount(0);
      await expect(history.locator('form')).toHaveCount(0);
      await expect(history.getByText(foreignDeclaration.systemId, { exact: false })).toHaveCount(0);
      await expect(history.getByText(rejectedDeclaration.systemId, { exact: false })).toHaveCount(
        0,
      );
      await expect(history.getByText('Final sensitivity', { exact: false })).toHaveCount(0);
    }
    const historyScreenshot = testInfo.outputPath('viewer-recorded-review.png');
    await viewer.getByRole('region', { name: historyName }).screenshot({ path: historyScreenshot });
    await testInfo.attach('viewer-recorded-review', {
      path: historyScreenshot,
      contentType: 'image/png',
    });

    await viewer.goto('/classification?reviewPage=1001');
    const invalidHistory = viewer.getByRole('region', { name: historyName });
    await expect(invalidHistory.getByRole('alert')).toContainText('between 1 and 1000');
    await expect(invalidHistory.getByRole('link', { name: 'Open the first page' })).toHaveAttribute(
      'href',
      '/classification',
    );
    await expect(invalidHistory.locator('li')).toHaveCount(0);
    await invalidHistory.getByRole('link', { name: 'Open the first page' }).click();
    await expect(viewer).toHaveURL(/\/classification$/);
    await expect(viewer.getByRole('region', { name: historyName })).toContainText(reviewId);

    await testInfo.attach('classification-review-boundary-summary', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          reviewId,
          foreignReviewId: foreignId,
          savedVia: 'authenticated BFF human review RPC',
          sourceProvenance: 'human declaration only; no verified agent source',
          viewerWriteStatus: refusal.status(),
          foreignReadStatus: foreignRead.status(),
          reloadChecked: true,
          invalidPageRecoveryChecked: true,
        }),
      ),
    });
  } finally {
    await ownerContext.close();
    await foreignContext.close();
    await viewerContext.close();
  }
});
