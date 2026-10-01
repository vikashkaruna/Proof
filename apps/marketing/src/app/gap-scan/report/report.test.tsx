import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/gap-scan-backend', () => ({ gapScanBackend: backend }));
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }));
import GapScanReportPage from './[id]/page';
import { SAMPLE_GAP_SCAN_RECORD } from '@/lib/gap-scan-store';

const id = 'c9910225-81b2-4ef9-84c9-29b14beafc14';
const params = (value: string) => ({ params: Promise.resolve({ id: value }) });

beforeEach(() => {
  backend.mockReset();
  cookieJar.get.mockReset();
});

it('renders the sample report with measured findings and recommendations', async () => {
  const html = renderToStaticMarkup(await GapScanReportPage(params('preview')));
  expect(html).toContain('Your DPDPA Readiness Report');
  expect(html).toContain('Encryption of Personal Data');
  expect(html).toContain('Establish 72-hour statutory breach');
  expect(backend).not.toHaveBeenCalled();
});

it('requires an ownership cookie before reading a stored report', async () => {
  await expect(GapScanReportPage(params(id))).rejects.toThrow();
  expect(backend).not.toHaveBeenCalled();
});

it('renders a live report only after a scoped, validated BFF read', async () => {
  const access = 'a'.repeat(64);
  cookieJar.get.mockReturnValue({ value: access });
  backend.mockResolvedValue(Response.json(SAMPLE_GAP_SCAN_RECORD));
  const html = renderToStaticMarkup(await GapScanReportPage(params(id)));
  expect(html).toContain('Your DPDPA Readiness Report');
  expect(backend).toHaveBeenCalledWith(`/public/gap-scan/${id}`, {
    headers: { 'X-Gap-Scan-Access': access },
  });
});

it('refuses a malformed backend report rather than presenting incomplete proof', async () => {
  cookieJar.get.mockReturnValue({ value: 'a'.repeat(64) });
  backend.mockResolvedValue(Response.json({ ...SAMPLE_GAP_SCAN_RECORD, report_snapshot: {} }));
  await expect(GapScanReportPage(params(id))).rejects.toThrow();
});
