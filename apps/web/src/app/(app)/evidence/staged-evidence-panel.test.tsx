// @vitest-environment jsdom
import React from 'react';
import { File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StagedEvidencePanel } from './staged-evidence-panel';
import { readStagedEvidenceJournal, stagedEvidenceJournalKey } from './staged-evidence-request';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const retention = {
  provider: 's3-compatible',
  bucket: 'owned-panel',
  lockMode: 'COMPLIANCE',
  retentionPolicy: 'seven_years',
  encryption: 'AES256',
  legalHold: false,
};
let postBody: Record<string, unknown> | null,
  lost: boolean,
  refused: boolean,
  lockAvailable: boolean;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  localStorage.clear();
  postBody = null;
  lost = false;
  refused = false;
  lockAvailable = true;
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => id });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(
        async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
          callback(lockAvailable ? {} : null),
      ),
    },
  });
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('staged-ingestion-options'))
      return Response.json({ enabled: true, retention });
    if (init?.method === 'POST') {
      postBody = JSON.parse(init.body as string);
      if (lost) throw new Error('lost response');
    }
    if (refused) return Response.json({}, { status: 403 });
    const journal = readStagedEvidenceJournal(localStorage, id, id)!;
    return Response.json({
      kind: 'accepted_staged_evidence',
      accepted: true,
      runId: id,
      evidenceId: id,
      objectVersionId: id,
      storageVersionId: 'owned-storage-version',
      operationKey: id,
      contentHash: journal.contentHash,
      sourceRequestHash: journal.bodyHash,
      stageOutputHash: 'c'.repeat(64),
      receipts: { requested: '100', started: '101', completed: '102', settled: '103' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'locks');
});
async function selectFile() {
  await screen.findByRole('button', { name: 'Approve and collect file' });
  fireEvent.change(screen.getByLabelText('Local file (up to 8 MiB)'), {
    target: { files: [new NodeFile(['owned bytes'], 'owned.txt', { type: 'text/plain' })] },
  });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'Human approved owned fixture' },
  });
}
async function collect() {
  await selectFile();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.submit(
    screen.getByRole('button', { name: 'Approve and collect file' }).closest('form')!,
  );
}
it('shows immutable consequence and requires explicit acknowledgement without automatic POST', async () => {
  render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  await selectFile();
  expect(screen.getByRole('checkbox').getAttribute('checked')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Approve and collect file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/Retention: seven years/).textContent).toContain('COMPLIANCE');
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('lost response keeps payload-free retained reference and uses GET to recover instead of duplicate upload', async () => {
  lost = true;
  render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  await collect();
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('unconfirmed');
  const saved = readStagedEvidenceJournal(localStorage, id, id)!;
  expect(saved.retentionApproval.acknowledgesImmutableRetention).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('contentBase64');
  expect(postBody).toHaveProperty('contentBase64');
  lost = false;
  fireEvent.click(screen.getByRole('button', { name: 'Check retained evidence result' }));
  await screen.findByText('Evidence accepted with matching storage and runtime receipts.');
  expect(screen.getByText('Storage version: owned-storage-version')).toBeTruthy();
  expect(screen.getByText(/^Evidence version record:/)).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('archive renews current server acceptance and preserves pending reference on current authority refusal', async () => {
  render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  await collect();
  await screen.findByText('Evidence accepted with matching storage and runtime receipts.');
  const before = localStorage.getItem(stagedEvidenceJournalKey(id, id));
  refused = true;
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm result and clear retained request' }),
  );
  await screen.findByRole('alert');
  expect(localStorage.getItem(stagedEvidenceJournalKey(id, id))).toBe(before);
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/result?bodyHash=')),
  ).toHaveLength(1);
});
it('successful archive renews proof then leaves accepted evidence IDs available for review', async () => {
  render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  await collect();
  await screen.findByText('Evidence accepted with matching storage and runtime receipts.');
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm result and clear retained request' }),
  );
  await waitFor(() => expect(localStorage.getItem(stagedEvidenceJournalKey(id, id))).toBeNull());
  expect(screen.getByText(`Evidence: ${id}`)).toBeTruthy();
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/result?bodyHash=')),
  ).toHaveLength(1);
});
it('another-tab lock refusal performs no durable write or submission', async () => {
  lockAvailable = false;
  render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  await collect();
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Another tab');
  expect(localStorage.getItem(stagedEvidenceJournalKey(id, id))).toBeNull();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('late previous-actor options cannot restore old approval controls', async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const rendered = render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  fetchMock.mockImplementationOnce(async () => Response.json({ enabled: false, retention: null }));
  rendered.rerender(<StagedEvidencePanel tenantId={id} actorId={other} />);
  await screen.findByText(/complete the environment setup/);
  resolve(Response.json({ enabled: true, retention }));
  await Promise.resolve();
  expect(screen.queryByRole('button', { name: 'Approve and collect file' })).toBeNull();
});
it('expired uncertain attempt preserves original target reference before a new explicit approval', async () => {
  lost = true;
  let terminal = false;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).includes('/status?') || String(url).endsWith('/expire')) {
      if (init?.method === 'POST') terminal = true;
      const journal = readStagedEvidenceJournal(localStorage, id, id)!;
      return Response.json({
        kind: 'unconfirmed_staged_evidence',
        accepted: false,
        operationKey: id,
        bodyHash: journal.bodyHash,
        runId: id,
        source: {
          purpose: 'saakshi_owned_resource_stage_v1',
          tenant_id: id,
          actor_id: id,
          engagement_id: null,
          operation_id: id,
          operation_key: id,
          owned_resource_id: id,
          human_request_hash: journal.bodyHash,
          provider: retention.provider,
          bucket: retention.bucket,
          object_key: `tenants/${id}/evidence-ingestions/${id}/${journal.contentHash}`,
          content_hash: journal.contentHash,
          byte_size: journal.byteSize,
          retain_until: '2034-01-01T00:00:00Z',
          legal_hold: false,
          encryption: 'AES256',
        },
        payloadExpiresAt: terminal ? null : '2026-01-01T00:00:00Z',
        payloadPurged: terminal,
        terminalReason: terminal ? 'expired_unconfirmed' : null,
        runtimeOutcome: 'unconfirmed',
        providerObservation: 'outcome_unknown',
        observedVersion: null,
        observedOutputHash: null,
        newApprovedKeyAllowed: terminal,
        requestedReceipt: '100',
      });
    }
    return original(url, init);
  });
  render(<StagedEvidencePanel tenantId={id} actorId={id} />);
  await collect();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Inspect original collection attempt' }));
  await screen.findByText('Storage observation: outcome unknown; an object may exist.');
  expect(
    screen.queryByRole('button', { name: 'Preserve expired reference and prepare new approval' }),
  ).toBeNull();
  const close = screen.getByRole('button', { name: 'Close expired collection attempt' });
  expect((close as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(close);
  await screen.findByRole('button', {
    name: 'Preserve expired reference and prepare new approval',
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Preserve expired reference and prepare new approval' }),
  );
  await waitFor(() => expect(localStorage.getItem(stagedEvidenceJournalKey(id, id))).toBeNull());
  const reference = localStorage.getItem(`axiom:staged-evidence:expired:v1:${id}:${id}:${id}`)!;
  expect(reference).toContain('outcome_unknown');
  expect(reference).toContain('owned-panel');
  expect(reference).not.toContain('contentBase64');
  expect(
    (screen.getByRole('button', { name: 'Approve and collect file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
});
