import { expect, it } from 'vitest';
import { BRANDED_PRESENTATION_V1 } from '../../../../../../packages/report-kit/src/branded-report';
import { PREVIEW_BRANDED_PRESENTATION_V1, reportPreviewVersion } from './report-preview-version';
it('pure client display pins match the authoritative immutable V1 policy exactly', () => {
  expect(PREVIEW_BRANDED_PRESENTATION_V1).toEqual(BRANDED_PRESENTATION_V1);
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
