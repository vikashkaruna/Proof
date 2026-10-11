// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailReportAction } from './email-report-action';
import { SAMPLE_GAP_SCAN_RECORD } from '@/lib/gap-scan-store';
const createPdf = vi.hoisted(() => vi.fn());
vi.mock('@/lib/gap-scan-pdf', () => ({ createGapScanPdf: createPdf }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
describe('independent PDF download', () => {
  it('downloads without an email address or any email dispatch request', async () => {
    const save = vi.fn();
    createPdf.mockResolvedValue({ save });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<EmailReportAction reportId="sample" pdfReport={SAMPLE_GAP_SCAN_RECORD} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report as PDF' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('Axiom-Proof-DPDPA-Readiness-sample.pdf'),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });
  it('shows a retryable rendering error, without claiming delivery', async () => {
    createPdf
      .mockRejectedValueOnce(new Error('font failed'))
      .mockResolvedValueOnce({ save: vi.fn() });
    render(<EmailReportAction reportId="sample" pdfReport={SAMPLE_GAP_SCAN_RECORD} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report as PDF' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('PDF could not be created');
    expect(screen.queryByText(/Dispatched/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download report as PDF' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
