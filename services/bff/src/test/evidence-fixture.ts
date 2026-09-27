import { createHash, randomUUID } from 'node:crypto';
import { vi, type Mock } from 'vitest';
import type { SealedEvidence } from '@axiom/evidence';
import type { EvidenceDatabase, EvidenceVaultApi } from '../services/evidence-ingestion.js';

type Row = Record<string, unknown>;
export const tenant = '11111111-1111-4111-8111-111111111111';
export const foreign = '22222222-2222-4222-8222-222222222222';
export const actor = '33333333-3333-4333-8333-333333333333';
export const operationKey = '44444444-4444-4444-8444-444444444444';
export const dataBody = Buffer.from('Synthetic evidence fixture.');
export const dataHash = createHash('sha256').update(dataBody).digest('hex');
export const upload = {
  operationKey,
  filename: 'fixture.txt',
  contentType: 'text/plain',
  evidenceType: 'document' as const,
  description: 'Synthetic test receipt',
  controlIds: [],
  contentBase64: dataBody.toString('base64'),
};
export const config = { bucket: 'fixture-evidence', provider: 's3-compatible' as const };

/** Models transport/query behavior only. Migration tests own SQL permissions and atomicity. */
export interface EvidenceFixture {
  db: EvidenceDatabase;
  vault: { [K in keyof EvidenceVaultApi]: Mock<EvidenceVaultApi[K]> };
  rows: (table: string) => Row[];
  faults: {
    begin: boolean;
    read: boolean;
    settle: boolean;
    settleResponseLost: boolean;
    note: boolean;
  };
  calls: { fn: string; args: Row }[];
  verified: SealedEvidence;
}
export function evidenceFixture(): EvidenceFixture {
  const tables: Record<string, Row[]> = {
    evidence: [],
    evidence_ingestions: [],
    evidence_object_versions: [],
  };
  const faults = {
    begin: false,
    read: false,
    settle: false,
    settleResponseLost: false,
    note: false,
  };
  const calls: { fn: string; args: Row }[] = [];
  const rows = (table: string) => (tables[table] ??= []);
  function query(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    const orders: { key: string; ascending: boolean }[] = [];
    let lower = 0;
    let upper = Number.MAX_SAFE_INTEGER;
    let exactCount = false;
    function execute() {
      if (faults.read) {
        faults.read = false;
        return { data: null, error: { message: 'sensitive diagnostic' }, count: null };
      }
      const result = rows(table).filter((row) => filters.every((predicate) => predicate(row)));
      result.sort((a, b) => {
        for (const order of orders) {
          const comparison =
            String(a[order.key] ?? '').localeCompare(String(b[order.key] ?? '')) *
            (order.ascending ? 1 : -1);
          if (comparison) return comparison;
        }
        return 0;
      });
      return {
        data: result.slice(lower, upper + 1).map((row) => ({ ...row })),
        error: null,
        count: exactCount ? result.length : null,
      };
    }
    const builder = {
      abortSignal(signal: AbortSignal) {
        signal.throwIfAborted();
        return builder;
      },
      select(_columns?: string, options?: { count?: string }) {
        exactCount = options?.count === 'exact';
        return builder;
      },
      eq(key: string, value: unknown) {
        filters.push((row) => row[key] === value);
        return builder;
      },
      or(expression: string) {
        const terms = expression.split(',').map((term) => {
          const [key, operator, value] = term.split('.');
          if (!key || operator !== 'eq' || value === undefined)
            throw new Error('Unsupported fixture OR expression');
          return (row: Row) => row[key] === value;
        });
        filters.push((row) => terms.some((matches) => matches(row)));
        return builder;
      },
      in(key: string, values: unknown[]) {
        filters.push((row) => values.includes(row[key]));
        return builder;
      },
      contains(key: string, values: unknown[]) {
        filters.push(
          (row) =>
            Array.isArray(row[key]) && values.every((v) => (row[key] as unknown[]).includes(v)),
        );
        return builder;
      },
      ilike(key: string, pattern: string) {
        const literal = pattern
          .slice(1, -1)
          .replace(/\\([\\%_])/g, '$1')
          .toLowerCase();
        filters.push((row) =>
          String(row[key] ?? '')
            .toLowerCase()
            .includes(literal),
        );
        return builder;
      },
      gte(key: string, value: string) {
        filters.push((row) => String(row[key]) >= value);
        return builder;
      },
      lte(key: string, value: string) {
        filters.push((row) => String(row[key]) <= value);
        return builder;
      },
      order(key: string, options: { ascending: boolean }) {
        orders.push({ key, ascending: options.ascending });
        return builder;
      },
      range(from: number, to: number) {
        lower = from;
        upper = to;
        return builder;
      },
      async maybeSingle() {
        const result = execute();
        return { ...result, data: result.data?.[0] ?? null };
      },
      then(resolve: (value: ReturnType<typeof execute>) => unknown) {
        return Promise.resolve(execute()).then(resolve);
      },
    };
    return builder;
  }
  async function rpc(fn: string, args: Row) {
    calls.push({ fn, args });
    if (fn === 'begin_evidence_ingest') {
      if (faults.begin) return { data: null, error: { message: 'sensitive begin error' } };
      const request = args.p_request as Row;
      const existing = rows('evidence_ingestions').find(
        (r) => r.tenant_id === args.p_tenant_id && r.operation_key === args.p_operation_key,
      );
      if (existing)
        return {
          data:
            JSON.stringify(existing.request) === JSON.stringify(request)
              ? { operation_id: existing.id, replayed: true }
              : { error: 'idempotency_conflict' },
          error: null,
        };
      const row = {
        id: randomUUID(),
        tenant_id: args.p_tenant_id,
        actor_id: args.p_actor_id,
        operation_key: args.p_operation_key,
        request,
        correlation_id: args.p_correlation_id,
        retain_until: '2034-01-01T00:00:00.000Z',
        status: 'pending',
        evidence_id: null,
        last_error_code: null,
        created_at: '2026-09-27T12:00:00.000Z',
      };
      rows('evidence_ingestions').push(row);
      return { data: { operation_id: row.id, replayed: false }, error: null };
    }
    const op = rows('evidence_ingestions').find(
      (r) => r.id === args.p_operation_id && r.tenant_id === args.p_tenant_id,
    );
    if (!op) return { data: { error: 'operation_not_found' }, error: null };
    if (fn === 'settle_evidence_ingest') {
      if (faults.settle) return { data: null, error: { message: 'sensitive settlement error' } };
      const receipt = args.p_receipt as Row;
      const request = op.request as Row;
      const id = randomUUID();
      const version = { id: randomUUID(), ...receipt, evidence_id: id, ingestion_id: op.id };
      rows('evidence_object_versions').push(version);
      rows('evidence').push({
        id,
        tenant_id: op.tenant_id,
        engagement_id: request.engagement_id,
        content_hash: request.content_hash,
        filename: request.filename,
        mime_type: request.mime_type,
        byte_size: request.byte_size,
        evidence_type: request.evidence_type,
        description: request.description,
        collected_by_agent: request.collected_by_agent,
        demonstrates_control_ids: request.control_ids,
        collected_at: '2026-09-27T12:01:00.000Z',
      });
      Object.assign(op, { status: 'settled', evidence_id: id, last_error_code: null });
      return faults.settleResponseLost
        ? { data: null, error: { message: 'response lost after commit' } }
        : { data: { evidence_id: id, status: 'settled' }, error: null };
    }
    if (fn === 'note_evidence_ingest_failure') {
      if (faults.note) throw new Error('failure journal unreachable');
      if (op.status === 'pending') op.last_error_code = args.p_error_code;
      return { data: { status: op.status }, error: null };
    }
    throw new Error(`Unexpected RPC ${fn}`);
  }
  const vault = {
    seal: vi.fn<EvidenceVaultApi['seal']>(),
    verifyReceipt: vi.fn<EvidenceVaultApi['verifyReceipt']>(),
    findEvidenceVersion: vi.fn<EvidenceVaultApi['findEvidenceVersion']>(),
    retrieve: vi.fn<EvidenceVaultApi['retrieve']>(),
  };
  const verified = {
    contentHash: dataHash,
    storageUri: 's3://fixture-evidence/key',
    bucket: config.bucket,
    key: 'key',
    byteSize: dataBody.length,
    retainUntil: '2034-01-01T00:00:00.000Z',
    lockMode: 'COMPLIANCE' as const,
    retentionAssurance: 'verified' as const,
    retentionAssuranceReason: 'Controlled provider fixture',
    versionId: 'fixture-version-1',
    encryption: 'AES256' as const,
    legalHold: false,
    readbackAt: new Date().toISOString(),
  };
  vault.seal.mockResolvedValue(verified);
  vault.verifyReceipt.mockResolvedValue(verified);
  vault.findEvidenceVersion.mockResolvedValue({ versionId: verified.versionId });
  vault.retrieve.mockResolvedValue({
    body: dataBody,
    contentHash: dataHash,
    metadata: {},
    contentType: 'text/plain',
    retainUntil: new Date(verified.retainUntil),
    lockMode: 'COMPLIANCE',
    versionId: 'fixture-version-1',
    encryption: 'AES256',
  });
  return {
    db: { from: query, rpc } as unknown as EvidenceDatabase,
    vault,
    rows,
    faults,
    calls,
    verified,
  };
}
