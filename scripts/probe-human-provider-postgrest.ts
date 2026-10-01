/** Real, isolated PostgREST role probe. Seed personas before running. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mintLocalPostgrestRoleKey } from '../packages/supabase/src/local-proof-writer-key.js';
import { createHumanActionWriter } from '../packages/supabase/src/human-action-writer.js';
import { createEvidenceIngestionWriter } from '../packages/supabase/src/evidence-ingestion-writer.js';
import type { PersonaState } from '../tests/e2e/personas.js';

const directory = resolve(process.env.AXIOM_PARITY_STATE_DIR ?? '.axiom-runtime/parity');
const status = JSON.parse(readFileSync(resolve(directory, 'status.json'), 'utf8')) as Record<
  string,
  string
>;
const personas = JSON.parse(
  readFileSync(resolve('.axiom-runtime/personas/state.json'), 'utf8'),
) as PersonaState;
const target = new URL(status.API_URL!);
if (
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  personas.supabaseUrl !== target.origin ||
  personas.serviceKey !== status.SERVICE_ROLE_KEY
) {
  throw new Error('PostgREST probe requires the seeded isolated local target');
}

const humanKey = mintLocalPostgrestRoleKey({
  role: 'human_action_writer',
  jwtSecret: status.JWT_SECRET!,
  serviceKey: status.SERVICE_ROLE_KEY!,
});
const evidenceKey = mintLocalPostgrestRoleKey({
  role: 'evidence_ingestion_writer',
  jwtSecret: status.JWT_SECRET!,
  serviceKey: status.SERVICE_ROLE_KEY!,
});
process.env.ENVIRONMENT = 'local';
process.env.SUPABASE_URL = target.origin;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY!;
process.env.SUPABASE_SERVICE_KEY = status.SERVICE_ROLE_KEY!;
process.env.SUPABASE_HUMAN_ACTION_WRITER_KEY = humanKey;
process.env.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY = evidenceKey;
const tenant = personas.tenantA.id;
const owner = personas.accounts.owner.id;

async function request(path: string, token: string, body: unknown, method = 'POST') {
  const response = await fetch(new URL(path, target), {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      apikey: status.ANON_KEY!,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}
function assert(value: boolean, label: string) {
  if (!value) throw new Error(`PostgREST boundary failed: ${label}`);
}

const policy = {
  p_tenant_id: tenant,
  p_actor_id: owner,
  p_title: 'Synthetic scoped writer proof',
  p_category: 'data_protection',
  p_summary: 'Isolated PostgREST credential boundary test',
  p_content: `Synthetic review body ${randomUUID()}`,
  p_citations: [],
  p_correlation_id: randomUUID(),
};
async function main() {
  const policyPath = '/rest/v1/rpc/create_policy_draft';
  const servicePolicy = await request(policyPath, status.SERVICE_ROLE_KEY!, policy);
  assert(servicePolicy.status === 403, 'generic service must not create human policy');
  const tamperedParts = humanKey.split('.');
  tamperedParts[2] = `${tamperedParts[2]![0] === 'A' ? 'B' : 'A'}${tamperedParts[2]!.slice(1)}`;
  const tamperedPolicy = await request(policyPath, tamperedParts.join('.'), policy);
  assert(tamperedPolicy.status === 401, 'forged writer signature must be refused');
  const wrongPolicy = await request(policyPath, evidenceKey, policy);
  assert(wrongPolicy.status === 403, 'evidence writer must not create human policy');
  const humanPolicy = await createHumanActionWriter().rpc('create_policy_draft', policy);
  assert(
    !humanPolicy.error &&
      typeof humanPolicy.data?.draftId === 'string' &&
      humanPolicy.data.status === 'draft',
    'human writer must create a real founder/owner draft',
  );

  const content = Buffer.from(`synthetic evidence intent ${randomUUID()}`, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  const operation = randomUUID();
  const evidence = {
    p_tenant_id: tenant,
    p_actor_id: owner,
    p_operation_key: operation,
    p_request: {
      content_hash: hash,
      byte_size: content.length,
      mime_type: 'text/plain',
      filename: 'synthetic.txt',
      evidence_type: 'document',
      description: 'Isolated pending provider intent',
      control_ids: [],
      engagement_id: null,
      collected_by_agent: 'human',
      provider: 's3-compatible',
      bucket: 'axiom-test-vault',
      object_key: `tenants/${tenant}/evidence-ingestions/${operation}/${hash}`,
      retention_policy: 'seven_years',
      legal_hold: false,
    },
    p_correlation_id: randomUUID(),
  };
  const evidencePath = '/rest/v1/rpc/begin_evidence_ingest';
  const serviceEvidence = await request(evidencePath, status.SERVICE_ROLE_KEY!, evidence);
  assert(serviceEvidence.status === 403, 'generic service must not begin evidence ingestion');
  const wrongEvidence = await request(evidencePath, humanKey, evidence);
  assert(wrongEvidence.status === 403, 'human writer must not begin evidence ingestion');
  const scopedEvidence = await createEvidenceIngestionWriter().rpc(
    'begin_evidence_ingest',
    evidence,
  );
  assert(
    !scopedEvidence.error &&
      typeof scopedEvidence.data?.operation_id === 'string' &&
      scopedEvidence.data.replayed === false,
    'evidence writer must create a real pending intent',
  );

  const forgedAlert = await request('/rest/v1/monitoring_alerts', status.SERVICE_ROLE_KEY!, {
    tenant_id: tenant,
    alert_type: 'drift_high',
    severity: 'high',
    title: 'Forged',
    summary: 'Must not persist',
    source_id: 'synthetic',
    source_type: 'drift_event',
  });
  assert(forgedAlert.status === 403, 'generic service must not write alerts directly');
  console.log(
    'Real PostgREST proof boundary: generic and cross-role denied; human draft and evidence intent committed.',
  );
}
main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
