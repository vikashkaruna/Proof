/** Real locally signed JWTs and synthetic trusted journals; no deployed admission proof. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentName,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
} from '@axiom/types';
import { sourceFixture, outputFixture } from '../services/prativedan-draft.test-fixture.js';
import { prativedanTextHash } from '../services/prativedan-draft-source.js';
import {
  PrativedanAssessmentAtomicController,
  PrativedanAtomicRefused,
  PrativedanAtomicOutcomeUnknown,
} from './prativedan-assessment-atomic-controller.js';
import { preparePrativedanAssessmentDraftSource } from '../services/prativedan-assessment-draft-source.js';
import { verifyPrativedanAssessmentDraftOutput } from '../services/prativedan-assessment-draft-output.js';
const domain = 'local.axiomproof.test';
const subject = `spiffe://${domain}/agent/prativedan`;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const foreignKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  headers: Record<string, unknown> = {},
  privateKey = keys.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const input =
    encode({ alg: 'ES256', kid: 'current', typ: 'JWT', ...headers }) +
    '.' +
    encode({
      sub: subject,
      aud: ['axiom-prativedan-assessment-tools'],
      iat: now,
      exp: now + 300,
      ...claims,
    });
  return (
    input +
    '.' +
    sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
      'base64url',
    )
  );
}
function fixture() {
  const f = sourceFixture();
  const { request_id: _request, ...oldSource } = f.source;
  const source = {
    ...oldSource,
    schema_version: 2,
    kind: 'prativedan_assessment_source',
    source_id: f.ids.assessment_run_id,
    title: f.witness.title,
    limitations: [
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.',
    ],
  };
  const sourceText = JSON.stringify(source, null, 1);
  const requestText = JSON.stringify(
    { ...f.request, expectedSourceSha256: prativedanTextHash(sourceText) },
    null,
    1,
  );
  const journal = {
    schema_version: 2,
    kind: 'prativedan_unpublished_draft',
    tenant_id: f.ids.tenant_id,
    actor_id: f.ids.tenant_id,
    engagement_id: f.ids.engagement_id,
    source_id: f.ids.assessment_run_id,
    assessment_run_id: f.ids.assessment_run_id,
    operation_key: f.ids.operation_key,
    run_id: f.ids.run_id,
    source_text: sourceText,
    source_sha256: prativedanTextHash(sourceText),
    request_text: requestText,
    request_sha256: prativedanTextHash(requestText),
    renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
    renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
    renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
    requested_receipt: { id: '4', entry_hash: 'a'.repeat(64) },
    state: 'requested',
    publication_allowed: false,
    review_required: true,
    citation_verification: 'unverified_references',
  };
  const selection = {
    tenantId: journal.tenant_id,
    operationKey: journal.operation_key,
    runId: journal.run_id,
    requestSha256: journal.request_sha256,
    sourceSha256: journal.source_sha256,
  };
  const context = {
    tenantId: journal.tenant_id,
    actorId: journal.actor_id,
    sessionId: f.ids.engagement_id,
  };
  const registration: {
    id: string;
    tenant_id: string;
    agent_name: AgentName;
    spiffe_id: string;
    status: 'active';
    version: number;
  } = {
    id: f.ids.source_id,
    tenant_id: journal.tenant_id,
    agent_name: AgentName.PRATIVEDAN,
    spiffe_id: subject,
    status: 'active' as const,
    version: 1,
  };
  const bundle = {
    revision: 'current',
    validUntil: Date.now() + 600000,
    jwks: {
      keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'current', use: 'jwt-svid' }],
    },
  };
  const ports = {
    trust: { load: vi.fn(async () => bundle), stillCurrent: vi.fn(async () => true) },
    registrations: {
      find: vi.fn<(tenantId: string, spiffeId: string) => Promise<unknown>>(
        async () => registration,
      ),
    },
    resolveCurrentHuman: vi.fn(async () => context),
    authorizeCurrentHuman: vi.fn(async () => {}),
    isKilled: vi.fn(async () => false),
    loadOriginalRequestedJournal: vi.fn(async () => ({
      journal: structuredClone(journal),
      reviewedRequestText: requestText,
    })),
  };
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
  >(async () => ({
    data: structuredClone(journal),
    error: null as unknown,
  }));
  const controllerWriterFactory = vi.fn(() => ({
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: async () => rpc(name, args),
    }),
  }));
  return {
    controller: new PrativedanAssessmentAtomicController(
      { trustDomain: domain },
      { ...ports, controllerWriterFactory },
    ),
    rpc,
    controllerWriterFactory,
    journal,
    requestText,
    selection,
    context,
    registration,
    bundle,
    ports,
  };
}

// Synthetic renderer bytes only; source/claims are explicitly rebuilt as v2.
function runtimeFixture() {
  const f = fixture();
  const rendered = outputFixture().envelope;
  const claim_expires_at = new Date(Date.now() + 240000).toISOString();
  const journal = {
    ...f.journal,
    state: 'invocation_uncertain',
    normalized_input_text: rendered.normalized_input_text,
    runtime_normalized_input_sha256: prativedanTextHash(rendered.normalized_input_text),
    claimed_receipt: { id: '5', entry_hash: 'b'.repeat(64) },
    claim_expires_at,
  };
  f.ports.loadOriginalRequestedJournal.mockResolvedValue({
    journal,
    reviewedRequestText: f.requestText,
  });
  const witness = {
    ...outputFixture().witness,
    schema_version: 2,
    source_id: journal.source_id,
    source_sha256: journal.source_sha256,
    request_sha256: journal.request_sha256,
    requested_receipt: journal.requested_receipt,
    claimed_receipt: journal.claimed_receipt,
    started_receipt: { id: '6', entry_hash: 'c'.repeat(64) },
    completed_receipt: { id: '7', entry_hash: 'd'.repeat(64) },
    claim_expires_at,
    completed_at: new Date().toISOString(),
  };
  const envelope = { ...rendered, ...witness };
  const verified = verifyPrativedanAssessmentDraftOutput(
    preparePrativedanAssessmentDraftSource(journal, f.requestText),
    envelope,
    witness,
  );
  const unpublished = {
    ...journal,
    state: 'unpublished',
    draft_id: '77777777-7777-4777-8777-777777777777',
    runtime_output_text: envelope.runtime_output_text,
    runtime_output_sha256: verified.runtimeOutputSha256,
    response_output_text: verified.responseOutputText,
    response_output_sha256: verified.responseOutputSha256,
    output: verified.output,
    started_receipt: witness.started_receipt,
    completed_receipt: witness.completed_receipt,
    settled_receipt: { id: '8', entry_hash: 'e'.repeat(64) },
  };
  return { ...f, journal, witness, envelope, unpublished };
}
describe('unmounted atomic controller verified identity boundary', () => {
  it('loads original source with a real verified JWT and exclusive scope only', async () => {
    const f = fixture();
    expect(await f.controller.perform(token(), f.selection, { kind: 'load' })).toEqual(f.journal);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls[0]![0]).toBe('load_prativedan_assessment_dispatch');
    expect(f.rpc.mock.calls[0]![1]).toMatchObject({
      authority: {
        actor_id: f.context.actorId,
        session_id: f.context.sessionId,
        workload_id: f.registration.id,
        registration_version: 1,
        subject,
      },
    });
    expect(f.rpc.mock.calls[0]![1]).not.toHaveProperty('agent_writer_key');
  });
  it.each([
    { sub: 'spiffe://local.axiomproof.test/agent/sanket' },
    { aud: ['foreign'] },
    { exp: 0 },
  ])('refuses wrong JWT before any SQL %j', async (claims) => {
    const f = fixture();
    await expect(
      f.controller.perform(token(claims), f.selection, { kind: 'load' }),
    ).rejects.toThrow(PrativedanAtomicRefused);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.ports.resolveCurrentHuman).not.toHaveBeenCalled();
  });
  it('refuses foreign cryptographic signer without SQL', async () => {
    const f = fixture();
    await expect(
      f.controller.perform(token({}, {}, foreignKeys.privateKey), f.selection, { kind: 'load' }),
    ).rejects.toThrow(PrativedanAtomicRefused);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['actor', 'session', 'kill', 'version', 'trust', 'source'])(
    'refuses changed %s during awaited reads before SQL',
    async (change) => {
      const f = fixture();
      if (change === 'actor')
        f.ports.resolveCurrentHuman.mockResolvedValue({ ...f.context, actorId: f.registration.id });
      if (change === 'session')
        f.ports.resolveCurrentHuman
          .mockResolvedValueOnce(f.context)
          .mockResolvedValue({ ...f.context, sessionId: f.registration.id });
      if (change === 'kill') f.ports.isKilled.mockResolvedValue(true);
      if (change === 'version')
        f.ports.registrations.find
          .mockResolvedValueOnce(f.registration)
          .mockResolvedValue({ ...f.registration, version: 2 });
      if (change === 'trust')
        f.ports.trust.stillCurrent.mockResolvedValueOnce(true).mockResolvedValue(false);
      if (change === 'source')
        f.ports.loadOriginalRequestedJournal.mockResolvedValue({
          journal: { ...f.journal, source_sha256: '0'.repeat(64) },
          reviewedRequestText: f.requestText,
        });
      await expect(f.controller.perform(token(), f.selection, { kind: 'load' })).rejects.toThrow(
        PrativedanAtomicRefused,
      );
      expect(f.rpc).not.toHaveBeenCalled();
    },
  );
  it('refuses registration retirement on the last read immediately before SQL', async () => {
    const f = fixture();
    f.ports.registrations.find
      .mockResolvedValueOnce(f.registration)
      .mockResolvedValueOnce(f.registration)
      .mockResolvedValue(null);
    await expect(f.controller.perform(token(), f.selection, { kind: 'load' })).rejects.toThrow(
      PrativedanAtomicRefused,
    );
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refuses changed input before claim', async () => {
    const f = fixture();
    const prepared = preparePrativedanAssessmentDraftSource(f.journal, f.requestText);
    const inputText = JSON.stringify({ ...prepared.rendererInput, title: 'unreviewed title' });
    await expect(
      f.controller.perform(token(), f.selection, { kind: 'claim', inputText }),
    ).rejects.toThrow(PrativedanAtomicRefused);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('retains exact first claim bytes and refuses reinvocation on replay', async () => {
    const f = fixture();
    const inputText = JSON.stringify(
      preparePrativedanAssessmentDraftSource(f.journal, f.requestText).rendererInput,
    );
    const expires_at = new Date(Date.now() + 240000).toISOString();
    const readback = {
      ...f.journal,
      state: 'invocation_uncertain',
      normalized_input_text: inputText,
      runtime_normalized_input_sha256: prativedanTextHash(inputText),
      claimed_receipt: { id: '5', entry_hash: 'b'.repeat(64) },
      claim_expires_at: expires_at,
    };
    f.rpc
      .mockResolvedValueOnce({ data: { claimed: true, expires_at, readback }, error: null })
      .mockResolvedValueOnce({
        data: { claimed: false, invocation_uncertain: true, readback },
        error: null,
      });
    expect(
      await f.controller.perform(token(), f.selection, { kind: 'claim', inputText }),
    ).toMatchObject({ claimed: true });
    expect(
      await f.controller.perform(token(), f.selection, { kind: 'claim', inputText }),
    ).toMatchObject({ claimed: false, invocation_uncertain: true });
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([
    { kind: 'phase', phase: 'started', outputHash: null },
    { kind: 'phase', phase: 'completed', outputHash: 'a'.repeat(64) },
    { kind: 'receipts', started: '5', completed: '6' },
  ])('refuses phase or receipt access before an actual claim %j', async (command) => {
    const f = fixture();
    await expect(f.controller.perform(token(), f.selection, command)).rejects.toThrow(
      PrativedanAtomicRefused,
    );
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refuses malformed retained load without a retry', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: { ...f.journal, source_sha256: '0'.repeat(64) }, error: null });
    await expect(f.controller.perform(token(), f.selection, { kind: 'load' })).rejects.toThrow(
      PrativedanAtomicOutcomeUnknown,
    );
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('records only the bounded fixed phase after a retained claim', async () => {
    const f = runtimeFixture();
    f.rpc.mockResolvedValue({ data: f.witness.started_receipt, error: null });
    await expect(
      f.controller.perform(token(), f.selection, {
        kind: 'phase',
        phase: 'started',
        outputHash: null,
      }),
    ).resolves.toEqual(f.witness.started_receipt);
    expect(f.rpc.mock.calls[0]![1]).toMatchObject({ phase_name: 'started', output_hash: null });
    expect(f.rpc.mock.calls[0]![1]).not.toHaveProperty('actor_id');
  });
  it('reads separately bound receipts without mutating', async () => {
    const f = runtimeFixture();
    f.rpc.mockResolvedValue({ data: f.witness, error: null });
    await expect(
      f.controller.perform(token(), f.selection, {
        kind: 'receipts',
        started: '6',
        completed: '7',
      }),
    ).resolves.toEqual(f.witness);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['started_receipt', 'completed_receipt'] as const)(
    'refuses a strict-shaped witness with mismatched %s ID',
    async (field) => {
      const f = runtimeFixture();
      const witness = {
        ...f.witness,
        [field]: { ...f.witness[field], id: field === 'started_receipt' ? '8' : '9' },
      };
      f.rpc.mockResolvedValue({ data: witness, error: null });
      await expect(
        f.controller.perform(token(), f.selection, {
          kind: 'receipts',
          started: '6',
          completed: '7',
        }),
      ).rejects.toThrow(PrativedanAtomicOutcomeUnknown);
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['equal', 'reversed', 'claimed'] as const)(
    'refuses %s receipt chronology despite exact requested IDs',
    async (order) => {
      const f = runtimeFixture();
      f.witness.started_receipt.id = order === 'claimed' ? '5' : '7';
      f.witness.completed_receipt.id = order === 'equal' ? '7' : order === 'reversed' ? '6' : '8';
      f.rpc.mockResolvedValue({ data: f.witness, error: null });
      await expect(
        f.controller.perform(token(), f.selection, {
          kind: 'receipts',
          started: f.witness.started_receipt.id,
          completed: f.witness.completed_receipt.id,
        }),
      ).rejects.toThrow(PrativedanAtomicOutcomeUnknown);
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['correlation_id', 'target_ref'] as const)(
    'refuses separately scoped receipts with foreign %s',
    async (field) => {
      const f = runtimeFixture();
      f.witness[field] = '99999999-9999-4999-8999-999999999999';
      f.rpc.mockResolvedValue({ data: f.witness, error: null });
      await expect(
        f.controller.perform(token(), f.selection, {
          kind: 'receipts',
          started: '6',
          completed: '7',
        }),
      ).rejects.toThrow(PrativedanAtomicOutcomeUnknown);
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['millisecond', 'nanosecond'] as const)(
    'refuses completion after claim expiry at %s precision',
    async (precision) => {
      const f = runtimeFixture();
      if (precision === 'nanosecond') {
        f.journal.claim_expires_at = '2026-10-13T12:00:00.123456Z';
        f.witness.claim_expires_at = f.journal.claim_expires_at;
        f.witness.completed_at = '2026-10-13T12:00:00.123456001Z';
      } else {
        f.witness.completed_at = new Date(Date.parse(f.witness.claim_expires_at) + 1).toISOString();
      }
      f.rpc.mockResolvedValue({ data: f.witness, error: null });
      await expect(
        f.controller.perform(token(), f.selection, {
          kind: 'receipts',
          started: '6',
          completed: '7',
        }),
      ).rejects.toThrow(PrativedanAtomicOutcomeUnknown);
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it('accepts completion exactly at expiry with an equivalent timezone representation', async () => {
    const f = runtimeFixture();
    f.journal.claim_expires_at = '2026-10-13T12:00:00.123456Z';
    f.witness.claim_expires_at = f.journal.claim_expires_at;
    f.witness.completed_at = '2026-10-13T17:30:00.123456+05:30';
    f.rpc.mockResolvedValue({ data: f.witness, error: null });
    await expect(
      f.controller.perform(token(), f.selection, {
        kind: 'receipts',
        started: '6',
        completed: '7',
      }),
    ).resolves.toEqual(f.witness);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('refuses foreign witness before settlement', async () => {
    const f = runtimeFixture();
    f.rpc.mockResolvedValue({
      data: { ...f.witness, request_sha256: '0'.repeat(64) },
      error: null,
    });
    await expect(
      f.controller.perform(token(), f.selection, { kind: 'settle', envelope: f.envelope }),
    ).rejects.toThrow(PrativedanAtomicOutcomeUnknown);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('preserves huge receipt IDs as exact decimal strings', async () => {
    const f = runtimeFixture();
    f.witness.started_receipt.id = '9007199254740993';
    f.witness.completed_receipt.id = '9007199254740995';
    f.rpc.mockResolvedValue({ data: f.witness, error: null });
    await expect(
      f.controller.perform(token(), f.selection, {
        kind: 'receipts',
        started: '9007199254740993',
        completed: '9007199254740995',
      }),
    ).resolves.toEqual(f.witness);
    expect(f.rpc.mock.calls[0]![1]).toMatchObject({
      started: '9007199254740993',
      completed: '9007199254740995',
    });
  });
  it('refuses newly revoked registration after receipt proof before settlement', async () => {
    const f = runtimeFixture();
    f.rpc.mockResolvedValue({ data: f.witness, error: null });
    f.ports.registrations.find
      .mockResolvedValueOnce(f.registration)
      .mockResolvedValueOnce(f.registration)
      .mockResolvedValueOnce(f.registration)
      .mockResolvedValue(null);
    await expect(
      f.controller.perform(token(), f.selection, { kind: 'settle', envelope: f.envelope }),
    ).rejects.toThrow(PrativedanAtomicRefused);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls[0]![0]).toBe('read_prativedan_assessment_runtime_receipts');
  });
  it('settles exact body only after independent receipt and full source semantic proof', async () => {
    const f = runtimeFixture();
    f.rpc
      .mockResolvedValueOnce({ data: f.witness, error: null })
      .mockResolvedValueOnce({ data: { ...f.unpublished, replayed: false }, error: null });
    await expect(
      f.controller.perform(token(), f.selection, { kind: 'settle', envelope: f.envelope }),
    ).resolves.toMatchObject({ state: 'unpublished', replayed: false });
    expect(f.rpc.mock.calls.map((c) => c[0])).toEqual([
      'read_prativedan_assessment_runtime_receipts',
      'settle_prativedan_assessment_draft',
    ]);
    expect(f.rpc.mock.calls[1]![1]).toMatchObject({
      output_text: f.envelope.runtime_output_text,
      response_text: f.unpublished.response_output_text,
    });
  });
  it('lost mutation response remains unknown with no retry', async () => {
    const f = fixture();
    const inputText = JSON.stringify(
      preparePrativedanAssessmentDraftSource(f.journal, f.requestText).rendererInput,
    );
    f.rpc.mockRejectedValue(new Error('Synthetic response loss'));
    await expect(
      f.controller.perform(token(), f.selection, { kind: 'claim', inputText }),
    ).rejects.toThrow(PrativedanAtomicOutcomeUnknown);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
});
