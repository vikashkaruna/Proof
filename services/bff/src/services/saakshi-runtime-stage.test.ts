import { canonicalJson } from '@axiom/ledger';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageFromSignedRuntime } from './saakshi-runtime-stage.js';
import type { EvidenceControllerRpc } from './saakshi-evidence-controller.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now = Date.now(),
  peer = 'owned-peer-'.padEnd(48, 'p'),
  secret = 'owned-source-'.padEnd(48, 's');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const source = {
    purpose: 'saakshi_owned_resource_stage_v1' as const,
    tenant_id: id,
    actor_id: id,
    engagement_id: null,
    operation_id: id,
    operation_key: id,
    owned_resource_id: id,
    human_request_hash: 'a'.repeat(64),
    provider: 's3-compatible' as const,
    bucket: 'owned-signed',
    object_key: `tenants/${id}/evidence-ingestions/${id}/${'b'.repeat(64)}`,
    content_hash: 'b'.repeat(64),
    byte_size: 3,
    retain_until: '2034-01-01T00:00:00Z',
    legal_hold: false,
    encryption: 'AES256' as const,
  };
  const binding = { source, runId: id, correlationId: id, requestedReceipt: '123' };
  const receipt = {
    tenant_id: id,
    engagement_id: null,
    operation_id: id,
    provider: source.provider,
    bucket: source.bucket,
    object_key: source.object_key,
    content_hash: source.content_hash,
    byte_size: 3,
    retain_until: source.retain_until,
    legal_hold: false,
    encryption: source.encryption,
    correlation_id: id,
    version_id: 'owned-version',
    collected_by_agent: 'saakshi',
    readback_at: new Date(now).toISOString(),
    lock_mode: 'COMPLIANCE',
    verified: true,
  };
  const envelope = {
    version: 1,
    input_text: canonicalJson(source),
    correlation_id: id,
    dispatch_context: { run_id: id, request_hash: sha(canonicalJson(source)) },
    expires_at: Math.floor(now / 1000) + 60,
  };
  const sign = (value = canonicalJson(envelope), key = secret) => ({
    signed_text: value,
    signature: createHmac('sha256', key)
      .update('axiom-saakshi-stage-v1\0')
      .update(value)
      .digest('hex'),
  });
  const output = { kind: 'sealed_pending_registration', accepted: false, source, receipt };
  const call = vi.fn<EvidenceControllerRpc['call']>(async (name) => ({
    data:
      name === 'bind_saakshi119_stage'
        ? binding
        : { recorded: true, replayed: false, output_hash: sha(canonicalJson(output)) },
    error: null,
  }));
  const stage = vi.fn(async () => receipt);
  return {
    source,
    binding,
    receipt,
    envelope,
    sign,
    call,
    stage,
    config: {
      peerSecret: peer,
      sourceSecret: secret,
      otherSecrets: [],
      rpc: { call },
      stage,
      now: () => now,
    },
  };
}
describe('source-signed internal staging', () => {
  it('resolves genuine claimed binding and records unaccepted exact version before reply', async () => {
    const f = fixture();
    expect(await stageFromSignedRuntime(f.sign(), 'Bearer ' + peer, f.config)).toEqual(f.receipt);
    expect(f.stage).toHaveBeenCalledWith(f.binding);
    expect(f.call.mock.calls.map(([name]) => name)).toEqual([
      'bind_saakshi119_stage',
      'record_saakshi119_stage',
    ]);
  });
  it.each(['peer', 'forgery', 'expired', 'long', 'input', 'context', 'unknown', 'keyreuse'])(
    'refuses %s before any source read or storage operation',
    async (kind) => {
      const f = fixture();
      let auth = 'Bearer ' + peer;
      if (kind === 'peer') auth = 'Bearer foreign';
      if (kind === 'expired') f.envelope.expires_at = Math.floor(now / 1000) - 1;
      if (kind === 'long') f.envelope.expires_at = Math.floor(now / 1000) + 121;
      if (kind === 'input') f.envelope.input_text += ' ';
      if (kind === 'context') f.envelope.dispatch_context.request_hash = '0'.repeat(64);
      if (kind === 'unknown') Object.assign(f.envelope, { providerUrl: 'foreign' });
      if (kind === 'keyreuse') f.config.sourceSecret = peer;
      await expect(
        stageFromSignedRuntime(
          f.sign(undefined, kind === 'forgery' ? peer : secret),
          auth,
          f.config,
        ),
      ).rejects.toThrow('unconfirmed');
      expect(f.call).not.toHaveBeenCalled();
      expect(f.stage).not.toHaveBeenCalled();
    },
  );
  it('refuses database source drift after signature but before storage', async () => {
    const f = fixture();
    f.binding.requestedReceipt = '124';
    f.binding.source.actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(
      stageFromSignedRuntime(
        f.sign(
          canonicalJson({
            ...f.envelope,
            input_text: canonicalJson({ ...f.source, actor_id: id }),
          }),
        ),
        'Bearer ' + peer,
        f.config,
      ),
    ).rejects.toThrow('unconfirmed');
    expect(f.stage).not.toHaveBeenCalled();
  });
  it('refuses failed observation acknowledgement without reporting a stage receipt', async () => {
    const f = fixture();
    f.call.mockImplementation(async (name) => ({
      data: name === 'bind_saakshi119_stage' ? f.binding : null,
      error: name === 'bind_saakshi119_stage' ? null : { message: 'private-provider-diagnostic' },
    }));
    await expect(stageFromSignedRuntime(f.sign(), 'Bearer ' + peer, f.config)).rejects.toThrow(
      'unconfirmed',
    );
    expect(f.stage).toHaveBeenCalledTimes(1);
  });
  it('bounds a source bind that ignores cancellation before any storage attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), milliseconds);
      return abort.signal;
    });
    const f = fixture();
    f.call.mockImplementation(() => new Promise(() => {}));
    let outcome = 'pending';
    const pending = stageFromSignedRuntime(f.sign(), 'Bearer ' + peer, f.config).then(
      () => {
        outcome = 'returned';
      },
      () => {
        outcome = 'refused';
      },
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect(outcome).toBe('refused');
    expect(f.stage).not.toHaveBeenCalled();
    await pending;
  });
});
