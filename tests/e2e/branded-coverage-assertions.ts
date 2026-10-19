import { expect, type Page } from '@playwright/test';

/** Document7's brand wrapper retains the exact source document and provenance. */
export async function assertBrandedCoverageDocument(
  preview: Page,
  expected: {
    requestId: string;
    title: string;
    runId: string;
    reviewId: string;
    sourceSha256: string;
    underlyingSourceSha256: string;
  },
) {
  // Document7 retains the source document heading beneath its branded cover.
  // Assert both exact headings rather than an ambiguous strict locator.
  const titleHeadings = preview.getByRole('heading', { name: expected.title, exact: true });
  await expect(titleHeadings).toHaveCount(2);
  await expect(
    preview.locator('.brand-cover').getByRole('heading', { name: expected.title, exact: true }),
  ).toBeVisible();
  await expect(titleHeadings.nth(1)).toBeVisible();
  await expect(
    preview.getByText(/^Scores and financial exposure estimates are withheld\./),
  ).toBeVisible();
  await expect(
    preview.getByRole('heading', { name: 'Scope and coverage', exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole('heading', { name: 'Review coverage and evidence needed', exact: true }),
  ).toBeVisible();
  // Both footers are intentional: immutable source provenance and company branding.
  await expect(preview.locator('footer')).toHaveCount(2);
  const footer = preview.locator('footer.provenance');
  await expect(footer).toHaveCount(1);
  await expect(footer).toBeVisible();
  const brandFooter = preview.locator('footer.brand-footer');
  await expect(brandFooter).toHaveCount(1);
  await expect(brandFooter).toBeVisible();
  for (const value of [
    'Axiom Minds Private Limited',
    'axiomminds.ai',
    'Axiom Proof',
    'axiomproof.ai',
    'hello@axiomminds.ai',
    '+919757281284',
  ])
    await expect(brandFooter).toContainText(value);
  for (const value of [
    expected.requestId,
    expected.runId,
    expected.reviewId,
    expected.underlyingSourceSha256,
  ]) {
    await expect(footer).toContainText(value);
  }
  await expect(preview.locator('.brand-cover')).toContainText(expected.sourceSha256);
  await expect(preview.locator('body')).toContainText(/Unknown/);
  await expect(preview.locator('body')).not.toContainText(
    /Posture score\s*[:=]?\s*\d|Estimated exposure\s*[:=]?\s*[₹0-9]|Score band\s*[:=]/i,
  );
}
