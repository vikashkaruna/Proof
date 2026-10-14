import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  ALL_MAPPING_CONTEXTS,
  ALL_CONTROL_MAPPINGS,
  MAPPING_CONTEXT_PUBLICATION_VERSION,
  mappingContextsForSectorControl,
} from './sector-packs';
import {
  mappingContextSourcePacket,
  mappingContextPacketSchema,
  publishMappingContextSource,
  verifyMappingContextPublicationProof,
  type MappingContextAuditBinding,
  type MappingContextPublicationPorts,
  adoptMappingContextPublication,
  verifyMappingContextAdoptionProof,
  verifyMappingContextReferenceProof,
  type MappingContextAdoptionBinding,
} from './mapping-context-publication';

const binding: MappingContextAuditBinding = {
  authorityTenantId: '10000000-0000-0000-0000-000000000001',
  publisherId: '20000000-0000-0000-0000-000000000002',
  correlationId: '30000000-0000-0000-0000-000000000003',
  sessionId: '40000000-0000-0000-0000-000000000004',
};
async function digest(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
async function proof(packetText = JSON.stringify(mappingContextSourcePacket())) {
  const packet = mappingContextSourcePacket();
  const packetSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(packetText))),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return {
    publicationVersion: packet.publicationVersion,
    libraryVersion: packet.libraryVersion,
    contextCount: packet.contexts.length,
    authorityTenantId: binding.authorityTenantId,
    publisherId: binding.publisherId,
    correlationId: binding.correlationId,
    packetText,
    packetSha256,
    sessionId: binding.sessionId,
    requestText: JSON.stringify(mappingContextSourcePacket()),
    requestSha256: await digest(JSON.stringify(mappingContextSourcePacket())),
  };
}
async function ports() {
  const value = await proof();
  return {
    authorizeCurrentHuman: vi.fn(async (): Promise<unknown> => ({
      binding,
      reviewedRequestText: JSON.stringify(mappingContextSourcePacket()),
    })),
    publish: vi.fn(async (_args: Readonly<Record<string, unknown>>) => ({
      data: value,
      error: null,
    })),
    readProof: vi.fn(async () => ({ data: value, error: null })),
  };
}
describe('unmounted mapping-context publication source and trusted-port composition (synthetic only)', () => {
  it('global publication provenance has no organisation ledger receipt (Option A)', async () => {
    const p = await ports();
    const returned = await publishMappingContextSource(p, binding);
    expect(returned).not.toHaveProperty('receipt');
    expect(returned).not.toHaveProperty('auditTenantId');
  });
  it('preserves all44 source notes with independent sector identity and unchanged44 legacy entries', () => {
    const packet = mappingContextSourcePacket();
    expect(packet.contexts).toHaveLength(44);
    expect(ALL_CONTROL_MAPPINGS).toHaveLength(44);
    expect(packet.contexts).toEqual(ALL_MAPPING_CONTEXTS);
    const notes = packet.contexts.filter(
      (m) =>
        m.frameworkCode === 'CERT-IN-DIRECTIONS-2022' &&
        m.ref === 'six-hour-incident-report' &&
        m.controlId === 'DPDPA-BRCH-001',
    );
    expect(notes).toHaveLength(3);
    expect(new Set(notes.map((m) => m.note)).size).toBe(3);
    for (const m of notes)
      expect(
        mappingContextsForSectorControl(
          MAPPING_CONTEXT_PUBLICATION_VERSION,
          m.sectorPackCode,
          m.controlId,
        ),
      ).toContainEqual(m);
    expect(
      mappingContextsForSectorControl('unknown', notes[0]!.sectorPackCode, notes[0]!.controlId),
    ).toEqual([]);
  });
  it('refuses duplicate exact identities and unknown context fields', () => {
    const packet = mappingContextSourcePacket();
    expect(() =>
      mappingContextPacketSchema.parse({
        ...packet,
        contexts: [...packet.contexts, packet.contexts[0]],
      }),
    ).toThrow();
    expect(() =>
      mappingContextPacketSchema.parse({
        ...packet,
        contexts: [{ ...packet.contexts[0], sector: 'all' }],
      }),
    ).toThrow();
  });
  it('verifies actual returned byte representation without substituting TS canonical text', async () => {
    const p = await proof(JSON.stringify(mappingContextSourcePacket(), null, 2));
    expect(
      await verifyMappingContextPublicationProof(
        p,
        binding,
        mappingContextSourcePacket(),
        JSON.stringify(mappingContextSourcePacket()),
      ),
    ).toEqual(p);
  });
  it.each(['authorityTenantId', 'publisherId', 'correlationId'] as const)(
    'refuses foreign %s proof',
    async (key) => {
      const p = await proof();
      p[key] = '50000000-0000-0000-0000-000000000005';
      await expect(
        verifyMappingContextPublicationProof(
          p,
          binding,
          mappingContextSourcePacket(),
          JSON.stringify(mappingContextSourcePacket()),
        ),
      ).rejects.toThrow();
    },
  );
  it('refuses changed content even when digest is recomputed', async () => {
    const packet = mappingContextSourcePacket();
    packet.contexts[0]!.note += ' altered';
    await expect(
      verifyMappingContextPublicationProof(
        await proof(JSON.stringify(packet)),
        binding,
        mappingContextSourcePacket(),
        JSON.stringify(mappingContextSourcePacket()),
      ),
    ).rejects.toThrow();
  });
  it('refuses mismatched byte hash', async () => {
    const p = await proof();
    p.packetSha256 = 'b'.repeat(64);
    await expect(
      verifyMappingContextPublicationProof(
        p,
        binding,
        mappingContextSourcePacket(),
        JSON.stringify(mappingContextSourcePacket()),
      ),
    ).rejects.toThrow();
  });
  it('publishes only reviewed source and verifies independent persisted proof', async () => {
    const p = await ports();
    const returned = await publishMappingContextSource(p, binding);
    expect(returned).toEqual(await proof());
    expect(p.publish).toHaveBeenCalledOnce();
    expect(p.readProof).toHaveBeenCalledOnce();
    expect(p.publish.mock.calls[0]![0]).toEqual({
      p_publication_version: MAPPING_CONTEXT_PUBLICATION_VERSION,
      p_library_version: '0.1.1',
      p_contexts: ALL_MAPPING_CONTEXTS,
      p_authority_tenant_id: binding.authorityTenantId,
      p_published_by: binding.publisherId,
      p_correlation_id: binding.correlationId,
      p_session_id: binding.sessionId,
      p_request_text: JSON.stringify(mappingContextSourcePacket()),
    });
  });
  it.each(['binding', 'reviewedRequestText'] as const)(
    'refuses changed trusted %s before writes',
    async (key) => {
      const p = await ports();
      p.authorizeCurrentHuman.mockResolvedValue(
        key === 'binding'
          ? {
              binding: { ...binding, sessionId: '50000000-0000-0000-0000-000000000005' },
              reviewedRequestText: JSON.stringify(mappingContextSourcePacket()),
            }
          : { binding, reviewedRequestText: '{}' },
      );
      await expect(
        publishMappingContextSource(p as MappingContextPublicationPorts, binding),
      ).rejects.toMatchObject({ publicationMayHaveCommitted: false });
      expect(p.publish).not.toHaveBeenCalled();
    },
  );
  it('caller MFA/source-review booleans are not authority', async () => {
    const p = await ports();
    p.authorizeCurrentHuman.mockResolvedValue({
      ...binding,
      mfaVerified: true,
      sourceReviewed: true,
    });
    await expect(publishMappingContextSource(p, binding)).rejects.toThrow();
    expect(p.publish).not.toHaveBeenCalled();
  });
  it('refuses publication-port mutation of dispatched source even with recomputed proof hash', async () => {
    const p = await ports();
    p.publish.mockImplementation(async (args) => {
      if (!Array.isArray(args.p_contexts) || typeof args.p_contexts[0] !== 'object')
        throw new Error('fixture');
      Reflect.set(args.p_contexts[0], 'note', 'Changed during dispatch');
      const packet = mappingContextPacketSchema.parse({
        ...mappingContextSourcePacket(),
        contexts: args.p_contexts,
      });
      return { data: await proof(JSON.stringify(packet)), error: null };
    });
    await expect(publishMappingContextSource(p, binding)).rejects.toMatchObject({
      publicationMayHaveCommitted: true,
    });
    expect(p.publish).toHaveBeenCalledOnce();
    expect(p.readProof).not.toHaveBeenCalled();
  });
  it('does not retry a lost publication response', async () => {
    const p = await ports();
    p.publish.mockRejectedValue(new Error('synthetic sensitive transport content'));
    await expect(publishMappingContextSource(p, binding)).rejects.toMatchObject({
      publicationMayHaveCommitted: true,
    });
    expect(p.publish).toHaveBeenCalledOnce();
    expect(p.readProof).not.toHaveBeenCalled();
  });
  it('refuses revoked authority after commit without rereading or republishing', async () => {
    const p = await ports();
    p.authorizeCurrentHuman
      .mockResolvedValueOnce({
        binding,
        reviewedRequestText: JSON.stringify(mappingContextSourcePacket()),
      })
      .mockRejectedValue(new Error('revoked'));
    await expect(publishMappingContextSource(p, binding)).rejects.toMatchObject({
      publicationMayHaveCommitted: true,
    });
    expect(p.publish).toHaveBeenCalledOnce();
    expect(p.readProof).not.toHaveBeenCalled();
  });
  it('refuses changed retained original review bytes without hidden replay', async () => {
    const p = await ports();
    const other = await proof();
    other.requestText += ' ';
    other.requestSha256 = await digest(other.requestText);
    p.readProof.mockResolvedValue({ data: other, error: null });
    await expect(publishMappingContextSource(p, binding)).rejects.toThrow();
    expect(p.publish).toHaveBeenCalledOnce();
  });
});

const adoptionBinding: MappingContextAdoptionBinding = {
  organisationId: binding.authorityTenantId,
  actorId: binding.publisherId,
  sessionId: binding.sessionId,
  correlationId: binding.correlationId,
};
const adoptionRequest = {
  operationKey: '50000000-0000-0000-0000-000000000005',
  publicationVersion: MAPPING_CONTEXT_PUBLICATION_VERSION,
  expectedPacketSha256: createHash('sha256')
    .update(JSON.stringify(mappingContextSourcePacket()))
    .digest('hex'),
  sectorPackCode: mappingContextSourcePacket().contexts[0]!.sectorPackCode,
};
async function referenceProof() {
  const packet = mappingContextSourcePacket();
  const packetText = JSON.stringify(packet);
  return {
    publicationVersion: packet.publicationVersion,
    libraryVersion: packet.libraryVersion,
    contextCount: packet.contexts.length,
    packetText,
    packetSha256: await digest(packetText),
  };
}
async function adoptionProof() {
  const requestText = JSON.stringify(adoptionRequest);
  return {
    ...adoptionBinding,
    operationKey: adoptionRequest.operationKey,
    publicationVersion: adoptionRequest.publicationVersion,
    libraryVersion: '0.1.1',
    sectorPackCode: adoptionRequest.sectorPackCode,
    packetSha256: adoptionRequest.expectedPacketSha256,
    requestText,
    requestSha256: await digest(requestText),
    receipt: { id: '184', entry_hash: 'a'.repeat(64) },
  };
}
async function adoptionPorts() {
  const value = await adoptionProof();
  return {
    readPublication: vi.fn(async () => ({ data: await referenceProof(), error: null })),
    authorizeCurrentHuman: vi.fn(async (): Promise<unknown> => ({
      binding: adoptionBinding,
      reviewedRequestText: JSON.stringify(adoptionRequest),
    })),
    adopt: vi.fn(async () => ({ data: value, error: null })),
    readProof: vi.fn(async () => ({ data: value, error: null })),
  };
}
describe('organisation-bound adoption (synthetic trusted ports, no human transport proof)', () => {
  it('records only server organisation and original reviewed bytes, verifies independent readback', async () => {
    const p = await adoptionPorts();
    expect(await adoptMappingContextPublication(p, adoptionBinding, adoptionRequest)).toEqual(
      await adoptionProof(),
    );
    expect(p.adopt).toHaveBeenCalledOnce();
    expect(p.readProof).toHaveBeenCalledOnce();
    expect(p.adopt.mock.calls[0]).toEqual([
      {
        p_tenant_id: adoptionBinding.organisationId,
        p_actor_id: adoptionBinding.actorId,
        p_session_id: adoptionBinding.sessionId,
        p_correlation_id: adoptionBinding.correlationId,
        p_request_text: JSON.stringify(adoptionRequest),
      },
    ]);
  });
  it.each([
    'organisationId',
    'actorId',
    'sessionId',
    'correlationId',
    'operationKey',
    'publicationVersion',
    'sectorPackCode',
    'packetSha256',
  ] as const)('refuses altered %s even with coherent receipt', async (key) => {
    const v = await adoptionProof();
    v[key] =
      key.endsWith('Id') || key === 'operationKey'
        ? '60000000-0000-0000-0000-000000000006'
        : 'changed';
    await expect(
      verifyMappingContextAdoptionProof(
        v,
        adoptionBinding,
        adoptionRequest,
        JSON.stringify(adoptionRequest),
        await referenceProof(),
      ),
    ).rejects.toThrow();
  });
  it('refuses oversized bigint receipt and accepts exact max', async () => {
    const p = await adoptionProof();
    p.receipt.id = '9223372036854775808';
    await expect(
      verifyMappingContextAdoptionProof(
        p,
        adoptionBinding,
        adoptionRequest,
        JSON.stringify(adoptionRequest),
        await referenceProof(),
      ),
    ).rejects.toThrow();
    p.receipt.id = '9223372036854775807';
    expect(
      await verifyMappingContextAdoptionProof(
        p,
        adoptionBinding,
        adoptionRequest,
        JSON.stringify(adoptionRequest),
        await referenceProof(),
      ),
    ).toEqual(p);
  });
  it('refuses caller org field and empty/missing trusted authorization', async () => {
    const p = await adoptionPorts();
    p.authorizeCurrentHuman.mockRejectedValue(new Error('revoked'));
    const untrusted = { ...adoptionRequest, organisationId: adoptionBinding.organisationId };
    await expect(adoptMappingContextPublication(p, adoptionBinding, untrusted)).rejects.toThrow();
    expect(p.adopt).not.toHaveBeenCalled();
  });
  it('lost adoption response stays uncertain without retry/read', async () => {
    const p = await adoptionPorts();
    p.adopt.mockRejectedValue(new Error('sensitive failure'));
    await expect(
      adoptMappingContextPublication(p, adoptionBinding, adoptionRequest),
    ).rejects.toMatchObject({ publicationMayHaveCommitted: true });
    expect(p.adopt).toHaveBeenCalledOnce();
    expect(p.readProof).not.toHaveBeenCalled();
  });
  it('revocation after commit prevents exposure without undo/retry', async () => {
    const p = await adoptionPorts();
    p.authorizeCurrentHuman
      .mockResolvedValueOnce({
        binding: adoptionBinding,
        reviewedRequestText: JSON.stringify(adoptionRequest),
      })
      .mockResolvedValueOnce({
        binding: adoptionBinding,
        reviewedRequestText: JSON.stringify(adoptionRequest),
      })
      .mockRejectedValue(new Error('revoked'));
    await expect(
      adoptMappingContextPublication(p, adoptionBinding, adoptionRequest),
    ).rejects.toMatchObject({ publicationMayHaveCommitted: true });
    expect(p.adopt).toHaveBeenCalledOnce();
    expect(p.readProof).not.toHaveBeenCalled();
  });
  it('different retained receipt refuses and never re-adopts', async () => {
    const p = await adoptionPorts();
    const v = await adoptionProof();
    v.receipt.id = '185';
    p.readProof.mockResolvedValue({ data: v, error: null });
    await expect(
      adoptMappingContextPublication(p, adoptionBinding, adoptionRequest),
    ).rejects.toThrow();
    expect(p.adopt).toHaveBeenCalledOnce();
  });
});

describe('independent global reference packet is mandatory before adoption', () => {
  it.each(['libraryVersion', 'packetSha256', 'contextCount', 'packetText'] as const)(
    'refuses altered reference %s before organisation writes',
    async (key) => {
      const p = await adoptionPorts();
      const value = await referenceProof();
      const changed = { ...value, [key]: key === 'contextCount' ? 1 : 'changed' };
      p.readPublication.mockResolvedValue({ data: changed, error: null });
      await expect(
        adoptMappingContextPublication(p, adoptionBinding, adoptionRequest),
      ).rejects.toMatchObject({ publicationMayHaveCommitted: false });
      expect(p.adopt).not.toHaveBeenCalled();
    },
  );
  it('refuses fake returned adoption library even with matching receipt', async () => {
    const value = await adoptionProof();
    value.libraryVersion = 'fake';
    await expect(
      verifyMappingContextAdoptionProof(
        value,
        adoptionBinding,
        adoptionRequest,
        JSON.stringify(adoptionRequest),
        await referenceProof(),
      ),
    ).rejects.toThrow();
  });
  it('refuses a self-consistent packet whose real digest differs from the original reviewed source hash', async () => {
    const source = await referenceProof();
    await expect(
      verifyMappingContextReferenceProof(source, {
        ...adoptionRequest,
        expectedPacketSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow();
  });
  it('refuses unknown sector and private/extra provenance supplied as public proof', async () => {
    const p = await adoptionPorts();
    const source = await referenceProof();
    await expect(
      verifyMappingContextReferenceProof(source, { ...adoptionRequest, sectorPackCode: 'UNKNOWN' }),
    ).rejects.toThrow();
    await expect(
      verifyMappingContextReferenceProof(
        { ...source, publisherId: binding.publisherId },
        adoptionRequest,
      ),
    ).rejects.toThrow();
  });
  it('accepts a correctly hashed immutable prior-version packet without latest-version fallback', async () => {
    const packet = {
      ...mappingContextSourcePacket(),
      publicationVersion: 'mapping-contexts-prior.v1',
      libraryVersion: 'prior-library',
    };
    const packetText = JSON.stringify(packet);
    const reference = {
      publicationVersion: packet.publicationVersion,
      libraryVersion: packet.libraryVersion,
      contextCount: packet.contexts.length,
      packetText,
      packetSha256: await digest(packetText),
    };
    const req = {
      ...adoptionRequest,
      publicationVersion: packet.publicationVersion,
      expectedPacketSha256: reference.packetSha256,
    };
    const requestText = JSON.stringify(req);
    const value = {
      ...(await adoptionProof()),
      publicationVersion: packet.publicationVersion,
      libraryVersion: packet.libraryVersion,
      packetSha256: reference.packetSha256,
      requestText,
      requestSha256: await digest(requestText),
    };
    expect(
      await verifyMappingContextAdoptionProof(value, adoptionBinding, req, requestText, reference),
    ).toEqual(value);
  });
  it('authority revoked while public source read awaits refuses before write', async () => {
    const p = await adoptionPorts();
    p.authorizeCurrentHuman
      .mockResolvedValueOnce({
        binding: adoptionBinding,
        reviewedRequestText: JSON.stringify(adoptionRequest),
      })
      .mockRejectedValue(new Error('revoked'));
    await expect(
      adoptMappingContextPublication(p, adoptionBinding, adoptionRequest),
    ).rejects.toMatchObject({ publicationMayHaveCommitted: false });
    expect(p.adopt).not.toHaveBeenCalled();
  });
});
