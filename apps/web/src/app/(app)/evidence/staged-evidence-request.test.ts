import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  prepareStagedEvidenceJournal,
  retainStagedEvidenceJournal,
  readStagedEvidenceJournal,
  stagedEvidenceJournalKey,
  submitStagedEvidence,
  readAcceptedStagedResult,
  archiveAcceptedStagedRequest,
  readUnconfirmedStagedStatus,
  archiveExpiredStagedRequest,
} from './staged-evidence-request';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const approval = {
  provider: 's3-compatible',
  bucket: 'owned',
  lockMode: 'COMPLIANCE',
  retentionPolicy: 'seven_years',
  encryption: 'AES256',
  legalHold: false,
  acknowledgesImmutableRetention: true,
};
const metadata = {
  filename: 'owned.txt',
  contentType: 'text/plain',
  evidenceType: 'document',
  description: 'owned',
  controlIds: [],
  engagementId: null,
};
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};
const current = () => ({ tenantId: id, actorId: id });
async function fixture() {
  const file = new File(['owned bytes'], 'owned.txt');
  const journal = await prepareStagedEvidenceJournal(id, id, id, metadata, approval, file);
  const result = {
    kind: 'accepted_staged_evidence',
    accepted: true,
    runId: id,
    evidenceId: id,
    objectVersionId: id,
    operationKey: id,
    contentHash: journal.contentHash,
    sourceRequestHash: journal.bodyHash,
    stageOutputHash: 'c'.repeat(64),
    receipts: { requested: '100', started: '101', completed: '102', settled: '103' },
  };
  return { file, journal, result };
}
afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});
describe('temporary human payload browser journal', () => {
  it('retains only metadata and hashes, never uploaded bytes or approvals fabricated by defaults', async () => {
    const f = await fixture();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    retainStagedEvidenceJournal(storage, f.journal);
    expect(readStagedEvidenceJournal(storage, id, id)).toEqual(f.journal);
    const text = storage.getItem(stagedEvidenceJournalKey(id, id))!;
    expect(text).not.toContain('contentBase64');
    expect(text).not.toContain(Buffer.from('owned bytes').toString('base64'));
    await expect(
      prepareStagedEvidenceJournal(
        id,
        id,
        id,
        metadata,
        { ...approval, acknowledgesImmutableRetention: false },
        f.file,
      ),
    ).rejects.toThrow();
  });
  it('silent storage loss refuses before any submission', async () => {
    const f = await fixture();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    expect(() =>
      retainStagedEvidenceJournal({ getItem: () => null, setItem: vi.fn() }, f.journal),
    ).toThrow('could not be retained');
  });
  it('altered file, actor or journal refuses before HTTP', async () => {
    const f = await fixture();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    retainStagedEvidenceJournal(storage, f.journal);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      submitStagedEvidence(
        storage,
        f.journal,
        new File(['other bytes'], 'owned.txt'),
        current,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    await expect(
      submitStagedEvidence(
        storage,
        f.journal,
        f.file,
        () => ({ tenantId: id, actorId: other }),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    storage.setItem(
      stagedEvidenceJournalKey(id, id),
      JSON.stringify({ ...f.journal, bodyHash: '0'.repeat(64) }),
    );
    await expect(
      submitStagedEvidence(storage, f.journal, f.file, current, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('lost response retains exact key/body metadata', async () => {
    const f = await fixture();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    retainStagedEvidenceJournal(storage, f.journal);
    const fetch = vi.fn(async () => {
      throw new Error('lost');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      submitStagedEvidence(storage, f.journal, f.file, current, AbortSignal.timeout(1000)),
    ).rejects.toThrow('unconfirmed');
    expect(readStagedEvidenceJournal(storage, id, id)).toEqual(f.journal);
    const args = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(args[1].headers).toMatchObject({ 'Idempotency-Key': id, 'X-Expected-Actor-Id': id });
    expect(JSON.parse(args[1].body as string).contentBase64).toBe(
      Buffer.from('owned bytes').toString('base64'),
    );
  });
  it.each(['accepted', 'content', 'body', 'duplicate', 'actor-drift', 'journal-drift'])(
    'refuses %s returned authority and retains journal',
    async (kind) => {
      const f = await fixture();
      vi.stubGlobal('window', { dispatchEvent: vi.fn() });
      retainStagedEvidenceJournal(storage, f.journal);
      const result = structuredClone(f.result);
      let actor = id;
      if (kind === 'accepted') result.accepted = false;
      if (kind === 'content') result.contentHash = '0'.repeat(64);
      if (kind === 'body') result.sourceRequestHash = '0'.repeat(64);
      if (kind === 'duplicate') result.receipts.completed = '101';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (kind === 'actor-drift') actor = other;
          if (kind === 'journal-drift')
            storage.setItem(
              stagedEvidenceJournalKey(id, id),
              JSON.stringify({ ...f.journal, bodyHash: '0'.repeat(64) }),
            );
          return Response.json(result);
        }),
      );
      await expect(
        readAcceptedStagedResult(
          storage,
          f.journal,
          () => ({ tenantId: id, actorId: actor }),
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow('unconfirmed');
      expect(storage.getItem(stagedEvidenceJournalKey(id, id))).not.toBeNull();
    },
  );
  it.each(['renewed', 'changed', 'refused', 'lost', 'context'])(
    'archive %s requires renewed exact server proof',
    async (kind) => {
      const f = await fixture();
      vi.stubGlobal('window', { dispatchEvent: vi.fn() });
      retainStagedEvidenceJournal(storage, f.journal);
      let actor = id;
      const fetch = vi.fn(async () => Response.json(f.result));
      vi.stubGlobal('fetch', fetch);
      const result = await readAcceptedStagedResult(
        storage,
        f.journal,
        current,
        AbortSignal.timeout(1000),
      );
      fetch.mockImplementation(async () => {
        if (kind === 'lost') throw new Error('lost');
        if (kind === 'refused') return Response.json({}, { status: 403 });
        if (kind === 'context') actor = other;
        return Response.json(kind === 'changed' ? { ...f.result, evidenceId: other } : f.result);
      });
      const promise = archiveAcceptedStagedRequest(
        storage,
        f.journal,
        result,
        () => ({ tenantId: id, actorId: actor }),
        AbortSignal.timeout(1000),
      );
      if (kind === 'renewed') {
        await promise;
        expect(storage.getItem(stagedEvidenceJournalKey(id, id))).toBeNull();
      } else {
        await expect(promise).rejects.toThrow('unconfirmed');
        expect(storage.getItem(stagedEvidenceJournalKey(id, id))).toBe(
          canonicalJson(f.journal) === JSON.stringify(f.journal)
            ? canonicalJson(f.journal)
            : JSON.stringify(f.journal),
        );
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});

describe('unconfirmed expired attempt preservation', () => {
  async function pendingFixture() {
    const f = await fixture();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    retainStagedEvidenceJournal(storage, f.journal);
    const source = {
      purpose: 'saakshi_owned_resource_stage_v1',
      tenant_id: id,
      actor_id: id,
      engagement_id: null,
      operation_id: id,
      operation_key: id,
      owned_resource_id: id,
      human_request_hash: f.journal.bodyHash,
      provider: 's3-compatible',
      bucket: 'owned',
      object_key: `tenants/${id}/evidence-ingestions/${id}/${f.journal.contentHash}`,
      content_hash: f.journal.contentHash,
      byte_size: f.journal.byteSize,
      retain_until: '2034-01-01T00:00:00Z',
      legal_hold: false,
      encryption: 'AES256',
    };
    const status = {
      kind: 'unconfirmed_staged_evidence',
      accepted: false,
      operationKey: id,
      bodyHash: f.journal.bodyHash,
      runId: id,
      source,
      payloadExpiresAt: null,
      payloadPurged: true,
      terminalReason: 'expired_unconfirmed',
      runtimeOutcome: 'unconfirmed',
      providerObservation: 'outcome_unknown',
      observedVersion: null,
      observedOutputHash: null,
      newApprovedKeyAllowed: true,
      requestedReceipt: '100',
    };
    return { ...f, status };
  }
  it.each([
    'valid',
    'actor',
    'target',
    'retention',
    'raw',
    'false-terminal',
    'observed-version',
    'runtime-outcome',
  ])('status %s binds exact original approved source', async (kind) => {
    const f = await pendingFixture();
    const status = structuredClone(f.status);
    if (kind === 'actor') status.source.actor_id = other;
    if (kind === 'target') status.source.object_key = 'arbitrary-target';
    if (kind === 'retention') status.source.legal_hold = true;
    if (kind === 'raw') Object.assign(status, { contentBase64: 'forbidden' });
    if (kind === 'false-terminal') status.newApprovedKeyAllowed = false;
    if (kind === 'observed-version') Object.assign(status, { observedVersion: 'unproved' });
    if (kind === 'runtime-outcome') status.runtimeOutcome = 'runtime_reported_failure';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(status)),
    );
    const pending = readUnconfirmedStagedStatus(
      storage,
      f.journal,
      current,
      AbortSignal.timeout(1000),
    );
    if (kind === 'valid') expect((await pending).providerObservation).toBe('outcome_unknown');
    else await expect(pending).rejects.toThrow('unconfirmed');
    expect(readStagedEvidenceJournal(storage, id, id)).toEqual(f.journal);
  });
  it.each(['valid', 'lost', 'changed', 'storage-loss'])(
    'expired archive %s preserves reference before removing retained request',
    async (kind) => {
      const f = await pendingFixture();
      const fetch = vi.fn(async () => Response.json(f.status));
      vi.stubGlobal('fetch', fetch);
      const status = await readUnconfirmedStagedStatus(
        storage,
        f.journal,
        current,
        AbortSignal.timeout(1000),
      );
      fetch.mockImplementation(async () => {
        if (kind === 'lost') throw new Error('lost');
        return Response.json(
          kind === 'changed' ? { ...f.status, requestedReceipt: '999' } : f.status,
        );
      });
      const writer = kind === 'storage-loss' ? { ...storage, setItem: vi.fn() } : storage;
      const pending = archiveExpiredStagedRequest(
        writer,
        f.journal,
        status,
        current,
        AbortSignal.timeout(1000),
      );
      if (kind === 'valid') {
        await pending;
        expect(readStagedEvidenceJournal(storage, id, id)).toBeNull();
        const saved = storage.getItem(`axiom:staged-evidence:expired:v1:${id}:${id}:${id}`)!;
        expect(saved).toContain('outcome_unknown');
        expect(saved).toContain(f.status.source.object_key);
        expect(saved).not.toContain('contentBase64');
      } else {
        await expect(pending).rejects.toThrow('unconfirmed');
        expect(readStagedEvidenceJournal(storage, id, id)).toEqual(f.journal);
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
