/** Disposable hosted-fixture verifier only. SQL/psql bridge and actual Python
 * invocation are established by the separate CI producer, never by these JSON
 * shapes alone. No HTTP, PostgREST, SPIRE, provider or publication proof. */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../packages/ledger/src/canonicalise.js';
import {
  prativedanAssessmentRequestedSchema,
  prativedanAssessmentClaimSchema,
  prativedanAssessmentSettlementSchema,
  prativedanAssessmentUnpublishedSchema,
  prativedanAssessmentDraftRequestSchema,
  prativedanLedgerReceiptSchema,
} from '../packages/types/src/index.js';
import { parsePrativedanAssessmentJson } from '../services/bff/src/services/prativedan-assessment-json.js';
import { preparePrativedanAssessmentDraftSource } from '../services/bff/src/services/prativedan-assessment-draft-source.js';
import {
  prativedanAssessmentRuntimeEnvelopeSchema,
  prativedanAssessmentRuntimeReceiptWitnessSchema,
  verifyPrativedanAssessmentDraftOutput,
} from '../services/bff/src/services/prativedan-assessment-draft-output.js';
import { prativedanTextHash } from '../services/bff/src/services/prativedan-draft-source.js';

const uuid = prativedanAssessmentDraftRequestSchema.shape.operationKey;
const digest = prativedanAssessmentDraftRequestSchema.shape.expectedSourceSha256;
const bindingSchema = z
  .object({
    tenant_id: uuid,
    actor_id: uuid,
    operation_key: uuid,
    engagement_id: uuid,
    assessment_run_id: uuid,
    source_id: uuid,
    run_id: uuid,
    request_text: z.string().min(1).max(4096),
    source_sha256: digest,
  })
  .strict();
const requestedSchema = z
  .object({
    schema_version: z.literal(1),
    fixture_kind: z.literal('disposable_postgres_assessment_v2'),
    requested_readback: prativedanAssessmentRequestedSchema,
    sql_input_projection: z.unknown(),
    expected_binding: bindingSchema,
  })
  .strict();
// Only these fields are used as proof. Other audit columns are discarded, never trusted.
const rowSchema = z.object({
  id: prativedanLedgerReceiptSchema.shape.id,
  tenant_id: uuid,
  sequence_no: z.number().int().safe().positive(),
  correlation_id: uuid,
  actor_type: z.enum(['human', 'system', 'agent']),
  actor_id: z.string().min(1).max(200),
  agent_version: z.string().nullable(),
  model_id: z.string().nullable(),
  prompt_hash: digest.nullable(),
  action_type: z.string().min(1).max(100),
  target_ref: z.string().nullable(),
  input_hash: digest.nullable(),
  output_hash: digest.nullable(),
  result: z.string(),
  detail: z.record(z.string(), z.unknown()),
  occurred_at: z.iso.datetime({ offset: true }),
  entry_hash: digest,
});
function check(condition: boolean): asserts condition {
  if (!condition) throw new Error('Disposable assessment runtime interoperability refused');
}
function read(directory: string, name: string): unknown {
  const path = join(directory, name);
  const info = lstatSync(path);
  check(
    info.uid === process.getuid?.() &&
      info.isFile() &&
      !info.isSymbolicLink() &&
      realpathSync(path) === path &&
      info.size <= 8388608 &&
      (info.mode & 0o777) === 0o600,
  );
  return parsePrativedanAssessmentJson(readFileSync(path, 'utf8'));
}
function write(directory: string, name: string, text: string) {
  writeFileSync(join(directory, name), text, { flag: 'wx', mode: 0o600 });
}
function rows(directory: string, name: string, tenant: string) {
  const values = z.array(rowSchema).min(7).max(100).parse(read(directory, name));
  check(
    values.every(
      (row, index) =>
        row.tenant_id === tenant &&
        (index === 0
          ? row.sequence_no === 1
          : row.sequence_no === values[index - 1]!.sequence_no + 1 &&
            BigInt(values[index - 1]!.id) < BigInt(row.id)),
    ),
  );
  return values;
}
function receiptRow(
  values: z.infer<typeof rowSchema>[],
  receipt: z.infer<typeof prativedanLedgerReceiptSchema>,
) {
  const matches = values.filter(
    (row) => row.id === receipt.id && row.entry_hash === receipt.entry_hash,
  );
  check(matches.length === 1);
  return matches[0]!;
}
function loadRuntime(directory: string) {
  const fixture = requestedSchema.parse(read(directory, 'pg-requested.json'));
  const original = fixture.requested_readback;
  const binding = fixture.expected_binding;
  check(
    binding.request_text === original.request_text &&
      binding.actor_id === original.actor_id &&
      binding.source_sha256 === original.source_sha256,
  );
  for (const key of [
    'tenant_id',
    'operation_key',
    'engagement_id',
    'assessment_run_id',
    'source_id',
    'run_id',
  ] as const)
    check(binding[key] === original[key]);
  const initial = preparePrativedanAssessmentDraftSource(original, binding.request_text);
  check(canonicalJson(initial.rendererInput) === canonicalJson(fixture.sql_input_projection));
  const claim = prativedanAssessmentClaimSchema.parse(read(directory, 'pg-claim-first.json'));
  check(claim.claimed);
  const {
    state: _state,
    claimed_receipt: _claim,
    normalized_input_text: _input,
    runtime_normalized_input_sha256: _hash,
    claim_expires_at: _expiry,
    ...frozen
  } = claim.readback;
  const { state: _originalState, ...originalFrozen } = original;
  check(canonicalJson(frozen) === canonicalJson(originalFrozen));
  const prepared = preparePrativedanAssessmentDraftSource(claim.readback, binding.request_text);
  const envelope = prativedanAssessmentRuntimeEnvelopeSchema.parse(
    read(directory, 'runtime-envelope.json'),
  );
  const witness = prativedanAssessmentRuntimeReceiptWitnessSchema.parse(
    read(directory, 'pg-runtime-witness.json'),
  );
  const verified = verifyPrativedanAssessmentDraftOutput(prepared, envelope, witness);
  const ledger = rows(directory, 'pg-runtime-ledger.json', original.tenant_id);
  for (const receipt of Object.values(prepared.source.receipts)) receiptRow(ledger, receipt);
  const requested = receiptRow(ledger, witness.requested_receipt);
  const claimed = receiptRow(ledger, witness.claimed_receipt);
  const started = receiptRow(ledger, witness.started_receipt);
  const completed = receiptRow(ledger, witness.completed_receipt);
  check(
    requested.action_type === 'prativedan.draft.requested' &&
      requested.actor_type === 'human' &&
      requested.actor_id === binding.actor_id &&
      requested.target_ref === binding.run_id &&
      requested.correlation_id === binding.operation_key &&
      requested.result === 'success' &&
      requested.input_hash === verified.requestSha256 &&
      requested.output_hash === verified.sourceSha256,
  );
  check(
    claimed.action_type === 'prativedan.draft.claimed' &&
      claimed.actor_type === 'system' &&
      claimed.actor_id === 'prativedan-draft-controller' &&
      claimed.target_ref === binding.run_id &&
      claimed.correlation_id === binding.operation_key &&
      claimed.result === 'pending' &&
      claimed.input_hash === verified.runtimeNormalizedInputSha256 &&
      claimed.output_hash === null &&
      claimed.detail.one_shot === true &&
      claimed.detail.request_hash === verified.requestSha256 &&
      claimed.detail.source_sha256 === verified.sourceSha256,
  );
  check(
    requested.agent_version === null &&
      requested.model_id === null &&
      requested.prompt_hash === null &&
      canonicalJson(requested.detail) ===
        canonicalJson({
          source_id: binding.source_id,
          engagement_id: binding.engagement_id,
          assessment_run_id: binding.assessment_run_id,
          run_id: binding.run_id,
          operation_key: binding.operation_key,
          renderer_config_version: verified.rendererConfigVersion,
          renderer_config_sha256: verified.rendererConfigSha256,
          publication_allowed: false,
          source_reviewed: true,
        }),
  );
  check(
    claimed.agent_version === '0.1.0' &&
      claimed.model_id === null &&
      claimed.prompt_hash === null &&
      canonicalJson(claimed.detail) ===
        canonicalJson({
          run_id: binding.run_id,
          request_hash: verified.requestSha256,
          source_sha256: verified.sourceSha256,
          renderer_config_version: verified.rendererConfigVersion,
          renderer_config_sha256: verified.rendererConfigSha256,
          one_shot: true,
        }),
  );
  for (const row of [started, completed])
    check(
      row.action_type === 'report.generated' &&
        row.actor_type === 'agent' &&
        row.actor_id === 'prativedan' &&
        row.agent_version === '0.1.0' &&
        row.correlation_id === binding.operation_key &&
        row.target_ref === binding.engagement_id &&
        row.input_hash === verified.runtimeNormalizedInputSha256 &&
        row.model_id === null &&
        row.prompt_hash === null,
    );
  const runtimeDetail = {
    run_id: binding.run_id,
    request_hash: verified.requestSha256,
    renderer_config_version: verified.rendererConfigVersion,
    renderer_config_sha256: verified.rendererConfigSha256,
  };
  check(
    started.result === 'pending' &&
      started.output_hash === null &&
      canonicalJson(started.detail) === canonicalJson({ ...runtimeDetail, phase: 'started' }),
  );
  check(
    completed.result === 'success' &&
      completed.output_hash === verified.runtimeOutputSha256 &&
      completed.occurred_at === witness.completed_at &&
      canonicalJson(completed.detail) ===
        canonicalJson({ ...runtimeDetail, phase: 'completed', started_entry: started.id }),
  );
  check(
    ledger.filter((row) => row.action_type === 'prativedan.draft.claimed').length === 1 &&
      ledger.filter((row) => row.action_type === 'report.generated').length === 2 &&
      !ledger.some(
        (row) =>
          row.action_type === 'prativedan.draft.settled' ||
          row.action_type === 'prativedan.draft.reviewed',
      ),
  );
  return { fixture, prepared, envelope, witness, verified, ledger };
}

try {
  check(process.argv.length === 4);
  const phase = z.enum(['runtime', 'settled']).parse(process.argv[2]);
  const directory = resolve(process.argv[3]!);
  const info = lstatSync(directory);
  check(
    info.uid === process.getuid?.() &&
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      realpathSync(directory) === directory &&
      (info.mode & 0o777) === 0o700,
  );
  const runtime = loadRuntime(directory);
  const { prepared, envelope, witness, verified, fixture } = runtime;
  const expectedArgs = {
    t: prepared.journal.tenant_id,
    k: prepared.journal.operation_key,
    r: prepared.journal.run_id,
    rh: verified.requestSha256,
    input_hash: verified.runtimeNormalizedInputSha256,
    config_text: envelope.renderer_config_text,
    output_text: envelope.runtime_output_text,
    response_text: verified.responseOutputText,
    started: witness.started_receipt.id,
    completed: witness.completed_receipt.id,
  };
  if (phase === 'runtime') {
    write(directory, 'response-output.txt', verified.responseOutputText);
    write(directory, 'settlement-arguments.json', JSON.stringify(expectedArgs));
    write(
      directory,
      'runtime-verification.json',
      JSON.stringify({
        schemaVersion: 1,
        evidenceKind: 'disposable_pg_actual_python_runtime_receipt_bindings',
        runtimeReceiptBindingsVerified: true,
        settlementProven: false,
        publicationAllowed: false,
        sourceSha256: verified.sourceSha256,
        requestSha256: verified.requestSha256,
        runtimeNormalizedInputSha256: verified.runtimeNormalizedInputSha256,
        runtimeOutputSha256: verified.runtimeOutputSha256,
        responseOutputSha256: verified.responseOutputSha256,
        rendererConfigSha256: verified.rendererConfigSha256,
      }),
    );
    console.log(
      'Disposable assessment actual runtime receipt bindings and TS semantics verified; settlement remains unproven.',
    );
  } else {
    check(
      canonicalJson(read(directory, 'settlement-arguments.json')) === canonicalJson(expectedArgs),
    );
    const responseInfo = lstatSync(join(directory, 'response-output.txt'));
    check(
      responseInfo.uid === process.getuid?.() &&
        responseInfo.isFile() &&
        !responseInfo.isSymbolicLink() &&
        (responseInfo.mode & 0o777) === 0o600 &&
        responseInfo.size <= 2097152 &&
        readFileSync(join(directory, 'response-output.txt'), 'utf8') ===
          verified.responseOutputText,
    );
    const first = prativedanAssessmentSettlementSchema.parse(read(directory, 'pg-settled.json'));
    const replay = prativedanAssessmentSettlementSchema.parse(
      read(directory, 'pg-settle-replay.json'),
    );
    const retained = prativedanAssessmentUnpublishedSchema.parse(
      read(directory, 'pg-retained.json'),
    );
    const { replayed: firstReplay, ...firstJournal } = first;
    const { replayed: replayReplay, ...replayJournal } = replay;
    check(
      !firstReplay &&
        replayReplay &&
        canonicalJson(firstJournal) === canonicalJson(retained) &&
        canonicalJson(replayJournal) === canonicalJson(retained),
    );
    const recovered = preparePrativedanAssessmentDraftSource(
      retained,
      fixture.expected_binding.request_text,
    );
    check(retained.actor_id === prepared.journal.actor_id);
    verifyPrativedanAssessmentDraftOutput(recovered, envelope, witness);
    const ledger = rows(directory, 'pg-settled-ledger.json', retained.tenant_id);
    check(
      ledger.length === runtime.ledger.length + 1 &&
        canonicalJson(ledger.slice(0, -1)) === canonicalJson(runtime.ledger),
    );
    const settled = receiptRow(ledger, retained.settled_receipt);
    check(
      settled === ledger.at(-1) &&
        settled.action_type === 'prativedan.draft.settled' &&
        settled.actor_type === 'system' &&
        settled.actor_id === 'prativedan-draft-controller' &&
        settled.agent_version === '0.1.0' &&
        settled.model_id === null &&
        settled.prompt_hash === null &&
        settled.correlation_id === retained.operation_key &&
        settled.target_ref === retained.run_id &&
        settled.result === 'success' &&
        settled.input_hash === verified.runtimeNormalizedInputSha256 &&
        settled.output_hash === verified.runtimeOutputSha256 &&
        canonicalJson(settled.detail) ===
          canonicalJson({
            run_id: retained.run_id,
            request_hash: verified.requestSha256,
            source_sha256: verified.sourceSha256,
            response_output_sha256: verified.responseOutputSha256,
            started_receipt: witness.started_receipt.id,
            completed_receipt: witness.completed_receipt.id,
            renderer_config_version: verified.rendererConfigVersion,
            renderer_config_sha256: verified.rendererConfigSha256,
            publication_allowed: false,
          }),
    );
    check(prativedanTextHash(retained.response_output_text) === verified.responseOutputSha256);
    write(
      directory,
      'settled-verification.json',
      JSON.stringify({
        schemaVersion: 1,
        evidenceKind: 'disposable_pg_actual_python_ts_settlement_recovery',
        runtimeReceiptsProven: true,
        settlementProven: true,
        exactReplayAndRecoveryVerified: true,
        publicationAllowed: false,
        providerAcceptanceProven: false,
        httpWorkloadAuthenticationProven: false,
        sourceSha256: verified.sourceSha256,
        requestSha256: verified.requestSha256,
        runtimeNormalizedInputSha256: verified.runtimeNormalizedInputSha256,
        runtimeOutputSha256: verified.runtimeOutputSha256,
        responseOutputSha256: verified.responseOutputSha256,
        rendererConfigSha256: verified.rendererConfigSha256,
        settledReceipt: retained.settled_receipt,
      }),
    );
    console.log(
      'Disposable assessment actual SQL/Python runtime receipts, TS semantics, settlement and exact replay/readback verified; publication remains prohibited.',
    );
  }
} catch {
  console.error('Disposable assessment runtime interoperability refused.');
  process.exitCode = 1;
}
