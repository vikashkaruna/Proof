import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createGapScanPdf } from './gap-scan-pdf';
import { SAMPLE_GAP_SCAN_RECORD } from './gap-scan-store';
afterEach(() => vi.unstubAllGlobals());
it('renders all long findings into a multi-page branded PDF from local fonts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(url).toMatch(
        /^\/(?:fonts\/NotoSans-(Regular|Bold)\.ttf|brand\/axiom-minds-company\.png)$/,
      );
      return new Response(new Uint8Array(readFileSync(resolve('public', url.slice(1)))));
    }),
  );
  const scan = structuredClone(SAMPLE_GAP_SCAN_RECORD);
  scan.contact_company = 'Example Organisation — Engineering Review';
  scan.report_snapshot.findings = Array.from({ length: 12 }, (_, i) => ({
    ...scan.report_snapshot.findings[i % 3]!,
    controlId: `DPDPA-TEST-${String(i + 1).padStart(3, '0')}`,
    rationale:
      'Review the supporting evidence and document responsible owners, validation and corrective actions. '.repeat(
        4,
      ),
  }));
  const doc = await createGapScanPdf(scan);
  expect(doc.getNumberOfPages()).toBeGreaterThan(2);
  const buffer = new Uint8Array(doc.output('arraybuffer'));
  expect(new TextDecoder().decode(buffer.subarray(0, 8))).toContain('%PDF-');
  if (process.env.AXIOM_PDF_REVIEW_OUTPUT)
    writeFileSync(process.env.AXIOM_PDF_REVIEW_OUTPUT, buffer, { mode: 0o600 });
});
it('refuses to create an incomplete PDF if its local font cannot load', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  await expect(createGapScanPdf(SAMPLE_GAP_SCAN_RECORD)).rejects.toThrow(
    'font could not be loaded',
  );
});
