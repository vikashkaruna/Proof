// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EvidenceClient } from './evidence-client';

const workflow = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('./evidence-workflow', () => ({ evidenceUploadBytes: workflow.upload, verifyLocalFile: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const operationKey = '11111111-1111-4111-8111-111111111111';
const empty = () => Response.json({ data: [], meta: { limit: 20, offset: 0, total: 0, hasMore: false } });
const row = {
  id: '33333333-3333-4333-8333-333333333333', engagement_id: null, content_hash: 'a'.repeat(64),
  filename: 'record.txt', mime_type: 'text/plain', byte_size: 1, evidence_type: 'document',
  description: 'Recorded file', collected_by_agent: null, collected_at: '2026-10-01T00:00:00Z',
  demonstrates_control_ids: [], assurance: 'legacy_unverified', object_version: null,
};
beforeEach(() => {
  workflow.upload.mockReset().mockResolvedValue({ fingerprint: 'digest-1', contentBase64: 'YQ==' });
  vi.stubGlobal('crypto', { randomUUID: () => operationKey });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows an empty vault without invented evidence or mutation controls for a reader', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(empty()));
  render(<EvidenceClient tenantId="tenant-1" canRecord={false} canExport={false} />);
  await waitFor(() => expect(screen.getByText('No evidence matches these filters.')).toBeTruthy());
  expect(screen.queryByRole('form', { name: 'Upload evidence' })).toBeNull();
  expect(screen.queryByText('Provider receipt recorded')).toBeNull();
});

it('keeps an unreadable evidence response as an error rather than an empty result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'fiction' }], meta: {} })));
  render(<EvidenceClient tenantId="tenant-1" canRecord={false} canExport={false} />);
  await waitFor(() => expect(screen.getByText(/server returned unreadable evidence records/)).toBeTruthy());
  expect(screen.queryByText('No evidence matches these filters.')).toBeNull();
});

it('drops selected evidence when a subsequent inventory read fails', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    reads++;
    return reads === 1
      ? Response.json({ data: [row], meta: { limit: 20, offset: 0, total: 1, hasMore: false } })
      : Response.json({ error: { code: 'unavailable' } }, { status: 503 });
  }));
  render(<EvidenceClient tenantId="tenant-1" canRecord={false} canExport={false} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /record.txt/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /record.txt/ }));
  expect(document.body.textContent).toContain('Recorded file');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unavailable'));
  expect(screen.queryByRole('button', { name: /record.txt/ })).toBeNull();
  expect(document.body.textContent).not.toContain('Stored-byte integrity and provider retention verified');
});

it('shows provider assurance only for the selected evidence identity', async () => {
  const withVersion = { ...row, assurance: 'verified_at_ingest', object_version: {
    id: '44444444-4444-4444-8444-444444444444', provider: 's3', version_id: 'version-1',
    lock_mode: 'COMPLIANCE', retain_until: '2033-10-01T00:00:00Z', readback_at: '2026-10-01T01:00:00Z',
    legal_hold: false, encryption: 'AES256',
  } };
  const verification = { evidenceId: '55555555-5555-4555-8555-555555555555', integrity: 'verified',
    retention: 'verified', verifiedAt: '2026-10-01T02:00:00Z', versionId: 'version-1',
    retainUntil: '2033-10-01T00:00:00Z', legalHold: false, encryption: 'AES256' };
  const fetcher = vi.fn().mockImplementation(async (url: string) =>
    url.endsWith('/verify')
      ? Response.json({ data: verification })
      : Response.json({ data: [withVersion], meta: { limit: 20, offset: 0, total: 1, hasMore: false } }));
  vi.stubGlobal('fetch', fetcher);
  render(<EvidenceClient tenantId="tenant-1" canRecord={false} canExport={false} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /record.txt/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /record.txt/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Verify provider receipt' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('/verify'))).toBe(true));
  expect(document.body.textContent).not.toContain('Stored-byte integrity and provider retention verified at');
});

it('retries an ambiguous upload with the same operation key in body and header', async () => {
  let mutationCount = 0;
  const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return empty();
    mutationCount++;
    if (mutationCount === 1) throw new Error('connection lost');
    return Response.json({ data: {
      operationId: '22222222-2222-4222-8222-222222222222', operationKey,
      status: 'pending', evidenceId: null, errorCode: null,
      createdAt: '2026-10-01T00:00:00Z', retainUntil: '2033-10-01T00:00:00Z',
    } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<EvidenceClient tenantId="tenant-1" canRecord canExport={false} />);
  await waitFor(() => expect(screen.getByText('No upload operations recorded on this page.')).toBeTruthy());
  const file = new File(['a'], 'record.txt', { type: 'text/plain' });
  fireEvent.change(screen.getByLabelText('Evidence file (maximum 8 MiB)'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Client-submitted record' } });
  fireEvent.click(screen.getByLabelText(/I reviewed this file and authorize/));
  const form = screen.getByRole('button', { name: 'Upload evidence' }).closest('form');
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('connection lost'));
  fireEvent.submit(form!);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Upload pending'));
  const mutations = fetcher.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(mutations).toHaveLength(2);
  expect(mutations[0]![1].headers['idempotency-key']).toBe(operationKey);
  expect(mutations[1]![1].headers['idempotency-key']).toBe(operationKey);
  expect(mutations[0]![1].body).toBe(mutations[1]![1].body);
  expect(JSON.parse(mutations[1]![1].body)).toMatchObject({ operationKey, filename: 'record.txt' });
});
