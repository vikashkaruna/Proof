// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportLedgerButton } from './export-ledger-button';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const props = { tenantId: 'tenant-1', tenantName: 'Actual tenant', tenantSlug: 'actual' };

it('refuses a malformed 200 response rather than downloading invented ledger proof', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ records: [], export_metadata: { total_records: 0, tenant: { id: 'other' }, export_truncated: false } })));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<ExportLedgerButton {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Export recorded ledger entries/ }));
  await waitFor(() => expect(document.body.textContent).toContain('No file was downloaded'));
  expect(click).not.toHaveBeenCalled();
});

it('downloads only the exact-tenant export and identifies truncation from the response', async () => {
  const bundle = { records: [{ sequence_no: 1 }], export_metadata: { total_records: 1, tenant: { id: 'tenant-1' }, export_truncated: true } };
  const fetcher = vi.fn().mockResolvedValue(Response.json(bundle));
  vi.stubGlobal('fetch', fetcher);
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<ExportLedgerButton {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Export recorded ledger entries/ }));
  await waitFor(() => expect(document.body.textContent).toContain('Export downloaded (1 records; truncated)'));
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/ledger?export=true&tenantId=tenant-1');
  expect(click).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
});
