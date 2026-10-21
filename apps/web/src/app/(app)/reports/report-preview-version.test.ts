import { expect, it } from 'vitest';
import { z } from 'zod';
import { PREVIEW_BRANDED_PRESENTATION_V1, reportPreviewVersion } from './report-preview-version';
it('pure client display pins match the authoritative immutable V1 policy exactly', async () => {
  // Runtime-only test dependency: Next's production type graph must not traverse
  // the server renderer and its dependencies outside the web installation.
  const serverUrl = new URL(
    '../../../../../../packages/report-kit/src/branded-report.ts',
    import.meta.url,
  );
  const server: unknown = await import(/* @vite-ignore */ serverUrl.href);
  const policy = z.object({ BRANDED_PRESENTATION_V1: z.unknown() }).parse(server);
  expect(PREVIEW_BRANDED_PRESENTATION_V1).toEqual(policy.BRANDED_PRESENTATION_V1);
});
it.each([5, 6] as const)(
  'refuses malformed or grafted doc7 while preserving exact legacy %s',
  (version) => {
    const doc = {
      schema_version: 7,
      underlying_document_version: version,
      source_sha256: 'a'.repeat(64),
      underlying_source_sha256: 'b'.repeat(64),
      organization_name: 'Synthetic company',
      presentation: PREVIEW_BRANDED_PRESENTATION_V1,
    };
    expect(reportPreviewVersion(doc, version, true)).toEqual({ ...doc, schema_version: version });
    expect(() => reportPreviewVersion(doc, version, false)).toThrow();
    for (const value of [
      { ...doc, underlying_document_version: version === 5 ? 6 : 5 },
      { ...doc, underlying_source_sha256: 'invalid' },
      { ...doc, source_sha256: 'invalid' },
      { ...doc, presentation: { ...doc.presentation, company: 'Forged' } },
      {
        ...doc,
        presentation: {
          ...doc.presentation,
          assets: { ...doc.presentation.assets, productLogo: 'f'.repeat(64) },
        },
      },
      { ...doc, presentation: { ...doc.presentation, inventedSeal: true } },
    ])
      expect(() => reportPreviewVersion(value, version, true)).toThrow();
    const historical = { schema_version: version };
    expect(reportPreviewVersion(historical, version, false)).toBe(historical);
  },
);
it('projects only digest-bound document8 with exact owner scope and incomplete-page declarations', () => {
  const tenant = '11111111-1111-4111-8111-111111111111';
  const engagement = '22222222-2222-4222-8222-222222222222';
  const snapshot = {
    version: 1,
    disposition: 'owner_declarations_unverified',
    tenantId: tenant,
    actorId: tenant,
    revisionId: tenant,
    previousRevisionId: null,
    recordedAt: '2026-10-21T00:00:00Z',
    request: {
      version: 1,
      operationKey: tenant,
      engagementId: engagement,
      checkId: tenant,
      payloadSha256: 'c'.repeat(64),
      expectedPreviousRevisionId: null,
      clarifications: ['root', 'privacy', 'contact', 'terms', 'consent'].map((page) => ({
        page,
        sourceState: 'unexamined',
        sourceTruncated: false,
        reasonCategory: 'needs_investigation',
        reason: 'Owner requests further examination of this important public information.',
        proposedPublicUrl: null,
      })),
    },
  };
  const doc = {
    schema_version: 8,
    underlying_document_version: 5,
    tenant_id: tenant,
    engagement_id: engagement,
    source_sha256: 'a'.repeat(64),
    branded_source_sha256: 'b'.repeat(64),
    underlying_source_sha256: 'd'.repeat(64),
    organization_name: 'Synthetic Company',
    presentation: PREVIEW_BRANDED_PRESENTATION_V1,
    owner_coverage_clarification: snapshot,
    owner_clarification_sha256: 'e'.repeat(64),
    owner_clarification_receipt: '123',
    coverage: { pages: [] },
    provenance: { capturePayloadSha256: 'c'.repeat(64) },
  };
  expect(reportPreviewVersion(doc, 5, true)).toEqual({ ...doc, schema_version: 5 });
  expect(() => reportPreviewVersion(doc, 5, false)).toThrow();
  for (const bad of [
    { ...doc, owner_clarification_receipt: tenant },
    { ...doc, owner_clarification_sha256: null },
    { ...doc, owner_coverage_clarification: null },
    { ...doc, tenant_id: engagement },
    { ...doc, provenance: { capturePayloadSha256: 'f'.repeat(64) } },
    {
      ...doc,
      owner_coverage_clarification: {
        ...snapshot,
        request: { ...snapshot.request, clarifications: [] },
      },
    },
    { ...doc, coverage: { pages: [{ page: 'privacy', state: 'examined', truncated: false }] } },
  ])
    expect(() => reportPreviewVersion(bad, 5, true)).toThrow();
  const questionnaire = {
    ...doc,
    underlying_document_version: 6,
    owner_coverage_clarification: null,
    owner_clarification_sha256: null,
    owner_clarification_receipt: null,
  };
  expect(reportPreviewVersion(questionnaire, 6, true)).toEqual({
    ...questionnaire,
    schema_version: 6,
  });
  expect(() =>
    reportPreviewVersion({ ...questionnaire, owner_coverage_clarification: snapshot }, 6, true),
  ).toThrow();
});
