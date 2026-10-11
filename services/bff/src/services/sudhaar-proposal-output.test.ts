import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { sudhaarInputSchema } from '@axiom/types';
import { createFakeDb } from '../test/fake-postgrest.js';
import { recoverSudhaarOutput, settleSudhaarOutput } from './sudhaar-proposal-output.js';
const setup = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
});
void setup;
const fixture = JSON.parse(readFileSync('../../tests/contracts/sudhaar-source.v1.json', 'utf8'));
const input = sudhaarInputSchema.parse(fixture.input),
  output = fixture.expectedOutput;
const actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888',
  run = '99999999-9999-4999-8999-999999999999';
let db: ReturnType<typeof createFakeDb>;
let row: Record<string, unknown>;
beforeEach(async () => {
  db = createFakeDb();
  row = {
    run_id: run,
    input_hash: await sha256(canonicalJson(input)),
    output_hash: await sha256(canonicalJson(output)),
    output_text: canonicalJson(output),
    requested_receipt: '1',
    started_receipt: '2',
    completed_receipt: '3',
    settled_receipt: '4',
  };
  db.onRpc('recover_sudhaar_output', () => row);
});
const writer = () => db.client as never;
it('returns exact validated canonical output with ordered actual proof IDs', async () => {
  const actual = await recoverSudhaarOutput(input.tenant_id, actor, key, input, writer);
  expect(actual?.data).toEqual(output);
  expect(actual?.outputProof).toMatchObject({
    kind: 'settled_output_recorded',
    actorId: actor,
    operationKey: key,
    settledReceipt: '4',
  });
});
it.each([
  'input_hash',
  'output_hash',
  'output_text',
  'requested_receipt',
  'completed_receipt',
  'run_id',
])('refuses corrupted persisted %s', async (field) => {
  row[field] = field.endsWith('_hash')
    ? 'f'.repeat(64)
    : field === 'output_text'
      ? '{}'
      : field === 'requested_receipt'
        ? '5'
        : field === 'completed_receipt'
          ? '1'
          : 'invalid';
  await expect(recoverSudhaarOutput(input.tenant_id, actor, key, input, writer)).rejects.toThrow();
});
it('strictly distinguishes a new key from legacy hash-only or uncertain output', async () => {
  row = { missing: true };
  expect(await recoverSudhaarOutput(input.tenant_id, actor, key, input, writer)).toBeNull();
  row = { error: 'output_unrecoverable' };
  await expect(recoverSudhaarOutput(input.tenant_id, actor, key, input, writer)).rejects.toThrow(
    'planning_output_uncertain',
  );
  row = { missing: true, output_text: canonicalJson(output) };
  await expect(recoverSudhaarOutput(input.tenant_id, actor, key, input, writer)).rejects.toThrow(
    'planning_output_conflict',
  );
});
it('refuses storage read failure, never synthesizes output', async () => {
  db.failNextRpc('recover_sudhaar_output');
  await expect(recoverSudhaarOutput(input.tenant_id, actor, key, input, writer)).rejects.toThrow(
    'planning_output_uncertain',
  );
});
it('settles only authenticated validated Sudhaar success with exact hash domains', async () => {
  const capture = vi.fn((_args: Record<string, unknown>) => ({
    run_id: run,
    status: 'succeeded',
    replayed: false,
  }));
  db.onRpc('settle_sudhaar_output', capture);
  const ctx = {
    agent: 'sudhaar',
    tenantId: input.tenant_id,
    actorId: actor,
    engagementId: input.engagement_id,
    correlationId: key,
    runId: run,
    requestHash: String(row.input_hash),
    canonicalInput: canonicalJson(input),
    canonicalOutput: canonicalJson(output),
    responseHash: String(row.output_hash),
    result: {
      agent: 'sudhaar',
      correlation_id: key,
      status: 'succeeded' as const,
      latency_ms: 1,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      error: null,
      output,
      ledger_entry_ids: ['2', '3'],
    },
  };
  await expect(settleSudhaarOutput(writer)(ctx)).resolves.toMatchObject({ status: 'succeeded' });
  expect(capture.mock.calls[0]?.[0]).toMatchObject({
    p_input_text: canonicalJson(input),
    p_output_text: canonicalJson(output),
    p_started_receipt: '2',
    p_completed_receipt: '3',
  });
  await expect(settleSudhaarOutput(writer)({ ...ctx, agent: 'drishti' })).rejects.toThrow();
  await expect(
    settleSudhaarOutput(writer)({ ...ctx, result: { ...ctx.result, output: {} } }),
  ).rejects.toThrow();
  expect(capture).toHaveBeenCalledTimes(1);
});
