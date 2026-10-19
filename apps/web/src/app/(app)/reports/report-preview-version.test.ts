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
