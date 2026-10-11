import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  archiveRetainedSanketReference,
  readRetainedSanketPublicSource,
  readRetainedSanketReference,
  recoverRetainedSanketReference,
  retainedSanketReferenceKey,
  submitRetainedSanketReference,
  type RetainedSanketReference,
  type RetainedSanketBrowserPorts,
} from './retained-sanket-reference';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
async function fixture() {
  const source = {
    check_id: id(6),
    capture_actor_id: id(7),
    capture_correlation_id: id(8),
    capture_receipt: '10',
    result_sha256: 'a'.repeat(64),
    requested_url: 'https://axiomminds.ai/',
    final_url: 'https://axiomminds.ai/',
    checked_at: '2026-10-08T07:41:58.139Z',
    content_sha256: 'b'.repeat(64),
    byte_size: 170,
    title: 'Synthetic public information',
    headings: ['Public services'],
  };
  const sourceDigest = await sha256(canonicalJson(source));
  const reference: RetainedSanketReference = {
    version: 1,
    tenantId: id(1),
    actorId: id(2),
    source,
    sourceDigest,
    request: {
      engagementId: id(3),
      checkId: id(6),
      sourceDigest,
      operationKey: id(5),
      confirmSourceReview: true,
    },
  };
  const input = {
    schema_version: 1,
    tenant_id: id(1),
    engagement_id: id(3),
    correlation_id: id(5),
    sectors: ['BFSI', 'Healthcare', 'SaaS / Tech'],
    geo: 'India',
    since: null,
    source,
  };
  const data = {
    signals: [],
    high_intent: [],
    processing_mode: 'verified_public_capture_review',
    source_observations: [
      {
        requested_url: source.requested_url,
        final_url: source.final_url,
        checked_at: source.checked_at,
        content_sha256: source.content_sha256,
        projection_sha256: await sha256(
          canonicalJson({
            requested_url: source.requested_url,
            final_url: source.final_url,
            checked_at: source.checked_at,
            content_sha256: source.content_sha256,
            byte_size: source.byte_size,
            title: source.title,
            headings: source.headings,
            capture_reference: source.check_id,
          }),
        ),
        capture_reference: source.check_id,
        observed_notice_kinds: [],
        requires_human_review: true,
      },
    ],
    notes:
      'Processed only supplied approved public captures and explicit title/heading markers. Zero score and empty high-intent list preserve unknown buying intent. Capture time is not notice publication time. Sector/geography preferences do not establish source-company classification. No contact records, outreach, login or message delivery is performed.',
  };
  const requestHash = await sha256(canonicalJson(input)),
    responseHash = await sha256(canonicalJson(data));
  return {
    reference,
    response: {
      data,
      invocation: { runId: id(4), correlationId: id(5), requestHash, responseHash },
      outputProof: {
        kind: 'settled_output_recorded',
        tenantId: id(1),
        actorId: id(2),
        operationKey: id(5),
        runId: id(4),
        requestHash,
        responseHash,
        requestedReceipt: '20',
        startedReceipt: '21',
        completedReceipt: '22',
        settledReceipt: '23',
      },
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>,
  values: Map<string, string>,
  current: { tenantId: string; actorId: string },
  transport: ReturnType<typeof vi.fn<typeof fetch>>,
  ports: RetainedSanketBrowserPorts;
beforeEach(async () => {
  f = await fixture();
  values = new Map();
  current = { tenantId: id(1), actorId: id(2) };
  transport = vi.fn(async () => new Response(JSON.stringify(f.response), { status: 200 }));
  ports = {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    currentIdentity: () => current,
    fetch: transport,
    exclusive: async (_key, action) => action(),
  };
});
describe('unmounted retained public-source browser reference', () => {
  it('reads only protected source preview and rejects a server-only witness', async () => {
    transport.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ source: f.reference.source, sourceDigest: f.reference.sourceDigest }),
        ),
    );
    expect(await readRetainedSanketPublicSource(id(1), id(2), id(3), id(6), ports)).toEqual({
      source: f.reference.source,
      sourceDigest: f.reference.sourceDigest,
    });
    expect(transport.mock.calls[0]?.[0]).toBe(
      `/api/bff/v1/retained-public-observations/source?engagementId=${id(3)}&checkId=${id(6)}`,
    );
    expect(transport.mock.calls[0]?.[1]?.headers).toEqual({
      'X-Tenant-Id': id(1),
      'X-Expected-Actor-Id': id(2),
    });
    transport.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            source: f.reference.source,
            sourceDigest: f.reference.sourceDigest,
            capture_result_text: 'private-witness',
          }),
        ),
    );
    await expect(readRetainedSanketPublicSource(id(1), id(2), id(3), id(6), ports)).rejects.toThrow(
      'proof_refused',
    );
  });
  it('retains exact body with readback before the sole explicit POST', async () => {
    transport.mockImplementation(async () => {
      expect(readRetainedSanketReference(ports.storage, id(1), id(2))).toEqual(f.reference);
      return new Response(JSON.stringify(f.response));
    });
    await submitRetainedSanketReference(f.reference, ports);
    expect(transport).toHaveBeenCalledOnce();
    const [path, init] = transport.mock.calls[0]!;
    expect(path).toBe('/api/bff/v1/retained-public-observations/runs');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'X-Tenant-Id': id(1),
      'X-Expected-Actor-Id': id(2),
      'Content-Type': 'application/json',
      'Idempotency-Key': id(5),
    });
    expect(init?.body).toBe(JSON.stringify(f.reference.request));
    expect(init?.credentials).toBe('same-origin');
    expect(values.size).toBe(1);
  });
  it('nonpersisting storage stops before POST rather than losing the recovery key', async () => {
    ports.storage.setItem = () => {};
    await expect(submitRetainedSanketReference(f.reference, ports)).rejects.toThrow(
      'reference_unavailable',
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not replace an outstanding operation with another body/key', async () => {
    await submitRetainedSanketReference(f.reference, ports);
    transport.mockClear();
    const changed = structuredClone(f.reference);
    changed.request.operationKey = id(99);
    await expect(submitRetainedSanketReference(changed, ports)).rejects.toThrow(
      'reference_changed',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(readRetainedSanketReference(ports.storage, id(1), id(2))).toEqual(f.reference);
  });
  it('lost committed acknowledgement preserves reference and explicit GET recovers same operation', async () => {
    transport.mockRejectedValueOnce(new Error('private-session-sentinel'));
    await expect(submitRetainedSanketReference(f.reference, ports)).rejects.toThrow(
      'outcome_unconfirmed',
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(readRetainedSanketReference(ports.storage, id(1), id(2))).toEqual(f.reference);
    const recovered = await recoverRetainedSanketReference(f.reference, ports);
    expect(recovered).toEqual(f.response);
    const [path, init] = transport.mock.calls[1]!;
    expect(path).toBe(
      `/api/bff/v1/retained-public-observations/runs/${id(5)}?engagementId=${id(3)}&checkId=${id(6)}&sourceDigest=${f.reference.sourceDigest}`,
    );
    expect(init?.method).toBeUndefined();
    expect(init?.headers).toEqual({ 'X-Tenant-Id': id(1), 'X-Expected-Actor-Id': id(2) });
    expect(values.size).toBe(1);
  });
  it('explicit archive freshly GETs same proof under the lock and removes only matching reference', async () => {
    const displayed = await submitRetainedSanketReference(f.reference, ports);
    transport.mockClear();
    const locks: string[] = [];
    ports.exclusive = async (key, action) => {
      locks.push(key);
      return action();
    };
    await archiveRetainedSanketReference(f.reference, displayed, ports);
    expect(locks).toEqual([retainedSanketReferenceKey(id(1), id(2))]);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(values.size).toBe(0);
  });
  it.each([401, 403, 409, 503])(
    'fresh authority refusal %s preserves journal during archive',
    async (status) => {
      const displayed = await submitRetainedSanketReference(f.reference, ports);
      transport.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'permission_refused', private: 'never-display' } }),
            { status },
          ),
      );
      await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
        'outcome_unconfirmed',
      );
      expect(values.size).toBe(1);
    },
  );
  it.each(['actor', 'tenant'])(
    'current %s switch refuses before any request or archive',
    async (field) => {
      const displayed = await submitRetainedSanketReference(f.reference, ports);
      transport.mockClear();
      current[field === 'actor' ? 'actorId' : 'tenantId'] = id(99);
      await expect(recoverRetainedSanketReference(f.reference, ports)).rejects.toThrow(
        'reference_changed',
      );
      await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
        'reference_changed',
      );
      expect(transport).not.toHaveBeenCalled();
      expect(values.size).toBe(1);
    },
  );
  it('actor changes during fresh archive response preserve the original reference', async () => {
    const displayed = await submitRetainedSanketReference(f.reference, ports);
    transport.mockImplementation(async () => {
      current.actorId = id(99);
      return new Response(JSON.stringify(f.response));
    });
    await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
      'reference_changed',
    );
    expect(values.size).toBe(1);
  });
  it('cross-tab body change during GET cannot remove another retained operation', async () => {
    const displayed = await submitRetainedSanketReference(f.reference, ports);
    const other = structuredClone(f.reference);
    other.request.operationKey = id(99);
    transport.mockImplementation(async () => {
      values.set(retainedSanketReferenceKey(id(1), id(2)), JSON.stringify(other));
      return new Response(JSON.stringify(f.response));
    });
    await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
      'reference_changed',
    );
    expect(readRetainedSanketReference(ports.storage, id(1), id(2))).toEqual(other);
  });
  it('manually constructed or later-mutated proof is not archive permission', async () => {
    const displayed = await submitRetainedSanketReference(f.reference, ports);
    transport.mockClear();
    await expect(
      archiveRetainedSanketReference(f.reference, structuredClone(displayed), ports),
    ).rejects.toThrow('reference_changed');
    displayed.outputProof.settledReceipt = '24';
    await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
      'reference_changed',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(values.size).toBe(1);
  });
  it('different fresh persisted output identity refuses archive even when separately consistent', async () => {
    const displayed = await submitRetainedSanketReference(f.reference, ports);
    const other = structuredClone(f.response);
    other.invocation.runId = other.outputProof.runId = id(99);
    transport.mockImplementation(async () => new Response(JSON.stringify(other)));
    await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
      'reference_changed',
    );
    expect(values.size).toBe(1);
  });
  it('failed removal readback preserves explicit archive failure', async () => {
    const displayed = await submitRetainedSanketReference(f.reference, ports);
    ports.storage.removeItem = () => {};
    await expect(archiveRetainedSanketReference(f.reference, displayed, ports)).rejects.toThrow(
      'reference_unavailable',
    );
    expect(values.size).toBe(1);
  });
  it.each([
    'actor',
    'run',
    'requestHash',
    'responseHash',
    'source',
    'receipts',
    'overflow',
    'review',
    'intent',
  ])('refuses corrupted saved proof %s even though no new work is requested', async (field) => {
    const response = structuredClone(f.response);
    if (field === 'actor') response.outputProof.actorId = id(99);
    if (field === 'run') response.outputProof.runId = id(99);
    if (field === 'requestHash') {
      response.outputProof.requestHash = 'f'.repeat(64);
      response.invocation.requestHash = 'f'.repeat(64);
    }
    if (field === 'responseHash') {
      response.outputProof.responseHash = 'f'.repeat(64);
      response.invocation.responseHash = 'f'.repeat(64);
    }
    if (field === 'source') {
      response.data.source_observations[0]!.capture_reference = id(99);
      response.outputProof.responseHash = response.invocation.responseHash = await sha256(
        canonicalJson(response.data),
      );
    }
    if (field === 'receipts') response.outputProof.startedReceipt = '22';
    if (field === 'overflow') response.outputProof.settledReceipt = '9999999999999999999';
    if (field === 'review')
      Object.assign(response.data.source_observations[0]!, { requires_human_review: false });
    if (field === 'intent') Object.assign(response.data, { high_intent: [{ score: 99 }] });
    transport.mockImplementation(async () => new Response(JSON.stringify(response)));
    await expect(recoverRetainedSanketReference(f.reference, ports)).rejects.toThrow(
      'proof_refused',
    );
    expect(transport.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
  it('source digest mutation stops before transport or storage', async () => {
    f.reference.source.title = 'Fake later source';
    await expect(submitRetainedSanketReference(f.reference, ports)).rejects.toThrow(
      'proof_refused',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
  it('unavailable cross-tab locking fails closed before submit', async () => {
    const old = ports.exclusive;
    delete ports.exclusive;
    vi.stubGlobal('navigator', undefined);
    try {
      await expect(submitRetainedSanketReference(f.reference, ports)).rejects.toThrow(
        'reference_unavailable',
      );
    } finally {
      ports.exclusive = old;
      vi.unstubAllGlobals();
    }
    expect(transport).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
  it('streaming oversized response is refused and the persisted reference remains', async () => {
    transport.mockImplementation(
      async () =>
        new Response(' '.repeat(65537) + JSON.stringify(f.response), {
          headers: { 'Content-Length': '1' },
        }),
    );
    await expect(submitRetainedSanketReference(f.reference, ports)).rejects.toThrow(
      'outcome_unconfirmed',
    );
    expect(values.size).toBe(1);
  });
  it('oversized or foreign browser reference remains unreadable rather than silently discarded', () => {
    const key = retainedSanketReferenceKey(id(1), id(2));
    values.set(key, 'x'.repeat(32769));
    expect(() => readRetainedSanketReference(ports.storage, id(1), id(2))).toThrow(
      'reference_unavailable',
    );
    expect(values.has(key)).toBe(true);
    values.set(key, JSON.stringify({ ...f.reference, actorId: id(99) }));
    expect(() => readRetainedSanketReference(ports.storage, id(1), id(2))).toThrow(
      'reference_unavailable',
    );
    expect(values.has(key)).toBe(true);
  });
});
