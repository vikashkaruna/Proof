import { canonicalJson } from '@axiom/ledger';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareStagedEvidence,
  recoverStagedEvidence,
  stagedEvidenceInvocationHook,
  recordStagedObservation,
  readUnconfirmedStagedEvidence,
} from './saakshi-evidence-controller.js';
import type { EvidenceControllerRpc } from './saakshi-evidence-controller.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const raw = Buffer.from('owned staged controller bytes');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const retention = {
  provider: 's3-compatible' as const,
  bucket: 'owned-controller',
  lockMode: 'COMPLIANCE' as const,
  retentionPolicy: 'seven_years' as const,
  encryption: 'AES256' as const,
  legalHold: false,
  acknowledgesImmutableRetention: true as const,
};
const { acknowledgesImmutableRetention: _acknowledgement, ...configuredRetention } = retention;
const key = { id: 'owned-test', key: Buffer.alloc(32, 3), otherKeys: [Buffer.alloc(32, 4)] };
function request() {
  return {
    operationKey: id,
    filename: 'owned.txt',
    contentType: 'text/plain',
    evidenceType: 'document',
    description: 'owned fixture',
    controlIds: [],
    contentBase64: raw.toString('base64'),
    retentionApproval: retention,
  };
}
function fixture() {
  const human = request(),
    bodyHash = hash(canonicalJson(human));
  const source = {
    purpose: 'saakshi_owned_resource_stage_v1' as const,
    tenant_id: id,
    actor_id: id,
    engagement_id: null,
    operation_id: id,
    operation_key: id,
    owned_resource_id: id,
    human_request_hash: bodyHash,
    provider: retention.provider,
    bucket: retention.bucket,
    object_key: `tenants/${id}/evidence-ingestions/${id}/${hash(raw)}`,
    content_hash: hash(raw),
    byte_size: raw.length,
    retain_until: '2034-01-01T00:00:00Z',
    legal_hold: false,
    encryption: 'AES256' as const,
  };
  const prepared = {
    run_id: id,
    operation_id: id,
    input_text: canonicalJson(source),
    input_hash: hash(canonicalJson(source)),
    human_body_hash: bodyHash,
    requested_receipt: '123',
    replayed: false,
  };
  const receipt = {
    ...source,
    correlation_id: id,
    version_id: 'owned-version',
    collected_by_agent: 'saakshi',
    readback_at: new Date().toISOString(),
    lock_mode: 'COMPLIANCE',
    verified: true,
  };
  for (const name of [
    'purpose',
    'actor_id',
    'operation_key',
    'owned_resource_id',
    'human_request_hash',
  ])
    delete (receipt as Record<string, unknown>)[name];
  const output = { kind: 'sealed_pending_registration', accepted: false, source, receipt };
  const saved = {
    accepted: true,
    run_id: id,
    evidence_id: id,
    object_version_id: id,
    input_text: prepared.input_text,
    input_hash: prepared.input_hash,
    output_text: canonicalJson(output),
    output_hash: hash(canonicalJson(output)),
    human_body_hash: bodyHash,
    requested_receipt: '123',
    started_receipt: '124',
    completed_receipt: '125',
    settled_receipt: '127',
  };
  const call = vi.fn<EvidenceControllerRpc['call']>(async (name) => ({
    data: name === 'prepare_saakshi119' ? prepared : saved,
    error: null,
  }));
  return { human, source, prepared, saved, output, call };
}
describe('dedicated human evidence composition', () => {
  it.each(['valid', 'actor', 'body', 'hash', 'raw', 'terminal', 'outcome', 'partial-version'])(
    'unconfirmed status %s preserves or refuses exact source without acceptance',
    async (kind) => {
      const f = fixture();
      const status = {
        kind: 'unconfirmed_staged_evidence',
        accepted: false,
        operation_key: id,
        run_id: id,
        input_text: f.prepared.input_text,
        input_hash: f.prepared.input_hash,
        human_body_hash: f.prepared.human_body_hash,
        requested_receipt: '123',
        payload_expires_at: null,
        payload_purged: true,
        terminal_reason: 'expired_unconfirmed',
        runtime_outcome: 'unconfirmed',
        provider_observation: 'outcome_unknown',
        observed_version: null as string | null,
        observed_output_hash: null,
        new_approved_key_allowed: true,
      };
      if (kind === 'actor') {
        f.source.actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        status.input_text = canonicalJson(f.source);
        status.input_hash = hash(status.input_text);
      }
      if (kind === 'body') status.human_body_hash = '0'.repeat(64);
      if (kind === 'hash') status.input_hash = '0'.repeat(64);
      if (kind === 'raw') Object.assign(status, { contentBase64: 'forbidden' });
      if (kind === 'terminal') status.new_approved_key_allowed = false;
      if (kind === 'outcome') status.runtime_outcome = 'runtime_reported_failure';
      if (kind === 'partial-version') status.observed_version = 'unsupported';
      f.call.mockResolvedValue({ data: status, error: null });
      const pending = readUnconfirmedStagedEvidence(
        { call: f.call },
        id,
        id,
        id,
        f.prepared.human_body_hash,
      );
      if (kind === 'valid') {
        const result = await pending;
        expect(result.accepted).toBe(false);
        expect(result.providerObservation).toBe('outcome_unknown');
        expect(result.newApprovedKeyAllowed).toBe(true);
        expect(result.source).toEqual(f.source);
      } else await expect(pending).rejects.toThrow();
    },
  );
  it('encrypts approved original bytes before one atomic prepare without generated hints', async () => {
    const f = fixture();
    const p = await prepareStagedEvidence({ call: f.call }, id, id, f.human, {
      key,
      retention: configuredRetention,
    });
    expect(p.binding.source).toEqual(f.source);
    expect(p.bodyHash).toBe(f.prepared.human_body_hash);
    const [name, args] = f.call.mock.calls[0]!;
    expect(name).toBe('prepare_saakshi119');
    expect(args.human_text).toBe(canonicalJson(f.human));
    expect(args.ciphertext).not.toBe('\\x' + raw.toString('hex'));
    expect(args).not.toHaveProperty('runid');
    expect(args).not.toHaveProperty('payloadid');
    expect(args).not.toHaveProperty('secret');
  });
  it.each(['ack', 'bucket', 'raw', 'normalization', 'extra'])(
    'refuses human %s drift before encryption/write',
    async (kind) => {
      const f = fixture();
      const human: Record<string, unknown> = structuredClone(f.human);
      if (kind === 'ack')
        human.retentionApproval = { ...retention, acknowledgesImmutableRetention: false };
      if (kind === 'bucket') human.retentionApproval = { ...retention, bucket: 'foreign-bucket' };
      if (kind === 'raw') human.contentBase64 = '@@@@';
      if (kind === 'normalization') human.description = ' owned fixture ';
      if (kind === 'extra') human.actions = ['invented'];
      await expect(
        prepareStagedEvidence({ call: f.call }, id, id, human, {
          key,
          retention: configuredRetention,
        }),
      ).rejects.toThrow();
      expect(f.call).not.toHaveBeenCalled();
    },
  );
  it.each(['actor', 'sourcehash', 'originalhash', 'operation', 'receipt'])(
    'refuses prepared %s drift before generic invocation',
    async (kind) => {
      const f = fixture();
      if (kind === 'actor') {
        f.source.actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        f.prepared.input_text = canonicalJson(f.source);
        f.prepared.input_hash = hash(f.prepared.input_text);
      }
      if (kind === 'sourcehash') f.prepared.input_hash = '0'.repeat(64);
      if (kind === 'originalhash') f.prepared.human_body_hash = '0'.repeat(64);
      if (kind === 'operation') f.prepared.operation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      if (kind === 'receipt') f.prepared.requested_receipt = 'unsafe';
      await expect(
        prepareStagedEvidence({ call: f.call }, id, id, f.human, {
          key,
          retention: configuredRetention,
        }),
      ).rejects.toThrow();
    },
  );
  it('recovers immutable receipt-linked output without raw payload after expiry', async () => {
    const f = fixture();
    f.output.receipt.readback_at = '2026-01-01T00:00:00Z';
    f.saved.output_text = canonicalJson(f.output);
    f.saved.output_hash = hash(f.saved.output_text);
    const saved = await recoverStagedEvidence(
      { call: f.call },
      id,
      id,
      id,
      f.saved.human_body_hash,
    );
    expect(saved.output.receipt.version_id).toBe('owned-version');
    expect(JSON.stringify(saved.saved)).not.toContain('contentBase64');
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it.each(['actor', 'body', 'outputhash', 'unknown'])(
    'refuses recovered %s drift',
    async (kind) => {
      const f = fixture();
      if (kind === 'actor') {
        f.source.actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        f.saved.input_text = canonicalJson(f.source);
        f.saved.input_hash = hash(f.saved.input_text);
      }
      if (kind === 'body') f.saved.human_body_hash = '0'.repeat(64);
      if (kind === 'outputhash') f.saved.output_hash = '0'.repeat(64);
      if (kind === 'unknown') Object.assign(f.saved, { ciphertext: 'forbidden' });
      await expect(
        recoverStagedEvidence({ call: f.call }, id, id, id, f.prepared.human_body_hash),
      ).rejects.toThrow();
    },
  );
  it('records exact unaccepted source/version output before runtime completion', async () => {
    const f = fixture();
    f.call.mockResolvedValue({
      data: { recorded: true, replayed: false, output_hash: f.saved.output_hash },
      error: null,
    });
    const binding = { source: f.source, runId: id, correlationId: id, requestedReceipt: '123' };
    const result = await recordStagedObservation({ call: f.call }, binding, f.output.receipt);
    expect(result.output.accepted).toBe(false);
    expect(f.call).toHaveBeenCalledWith(
      'record_saakshi119_stage',
      expect.objectContaining({ output_text: canonicalJson(f.output), ih: f.prepared.input_hash }),
      expect.any(AbortSignal),
    );
  });
  it.each([
    'actor',
    'tenant',
    'engagement',
    'key',
    'agent',
    'runtime-agent',
    'runtime-key',
    'failed',
    'error',
    'receipt-count',
    'receipt-duplicate',
    'receipt-format',
    'canonical-output',
    'response-hash',
  ])('refuses settlement %s drift before either SQL call', async (kind) => {
    const f = fixture();
    const prepared = await prepareStagedEvidence({ call: f.call }, id, id, f.human, {
      key,
      retention: configuredRetention,
    });
    const hook = stagedEvidenceInvocationHook({ call: f.call }, prepared);
    const context: Parameters<typeof hook.settleSuccess>[0] = {
      agent: 'saakshi',
      tenantId: id,
      actorId: id,
      engagementId: null,
      correlationId: id,
      runId: id,
      canonicalInput: f.prepared.input_text,
      requestHash: f.prepared.input_hash,
      canonicalOutput: f.saved.output_text,
      responseHash: f.saved.output_hash,
      result: {
        agent: 'saakshi',
        correlation_id: id,
        status: 'succeeded',
        output: f.output,
        ledger_entry_ids: ['124', '125'],
        error: null,
        latency_ms: 1,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
    };
    const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const drift = structuredClone(context);
    const changed = {
      ...drift,
      ...(kind === 'actor' ? { actorId: other } : {}),
      ...(kind === 'tenant' ? { tenantId: other } : {}),
      ...(kind === 'engagement' ? { engagementId: other } : {}),
      ...(kind === 'key' ? { correlationId: other } : {}),
      ...(kind === 'agent' ? { agent: 'vibhaag' } : {}),
      ...(kind === 'canonical-output' ? { canonicalOutput: f.saved.output_text + ' ' } : {}),
      ...(kind === 'response-hash' ? { responseHash: '0'.repeat(64) } : {}),
    };
    if (kind === 'runtime-agent') changed.result.agent = 'vibhaag';
    if (kind === 'runtime-key') changed.result.correlation_id = other;
    if (kind === 'failed') changed.result.status = 'failed';
    if (kind === 'error') changed.result.error = 'unexpected';
    if (kind === 'receipt-count') changed.result.ledger_entry_ids.push('126');
    if (kind === 'receipt-duplicate') changed.result.ledger_entry_ids = ['124', '124'];
    if (kind === 'receipt-format') changed.result.ledger_entry_ids = ['unsafe', '125'];
    f.call.mockClear();
    await expect(hook.settleSuccess(changed)).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  });
});

it.each(['0', '01', '-1', '+1', '1.0', ' 1', '9223372036854775808', '10000000000000000000'])(
  'prepared source refuses noncanonical or overflowing receipt before dispatch: %s',
  async (value) => {
    const f = fixture();
    f.prepared.requested_receipt = value;
    await expect(
      prepareStagedEvidence({ call: f.call }, id, id, f.human, {
        key,
        retention: configuredRetention,
      }),
    ).rejects.toThrow();
  },
);
