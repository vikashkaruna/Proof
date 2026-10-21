import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import {
  publicCoverageClarificationRecordSchema,
  publicCoverageClarificationRequestSchema,
  publicCoverageClarificationSnapshotSchema,
} from '@axiom/types';
const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export function verifyPublicCoverageClarification(
  value: unknown,
  scope: {
    tenantId: string;
    engagementId: string;
    checkId: string;
    payloadSha256: string;
    operationKey?: string;
    actorId?: string;
    requestText?: string;
  },
) {
  const record = publicCoverageClarificationRecordSchema.parse(value);
  const request = publicCoverageClarificationRequestSchema.parse(
    parseCatalogueJson(record.requestText, 16384),
  );
  const snapshot = publicCoverageClarificationSnapshotSchema.parse(
    parseCatalogueJson(record.snapshotText, 24576),
  );
  if (
    record.tenantId !== scope.tenantId ||
    record.engagementId !== scope.engagementId ||
    record.checkId !== scope.checkId ||
    record.payloadSha256 !== scope.payloadSha256 ||
    (scope.operationKey !== undefined && record.operationKey !== scope.operationKey) ||
    (scope.actorId !== undefined && record.actorId !== scope.actorId) ||
    (scope.requestText !== undefined && record.requestText !== scope.requestText) ||
    record.requestSha256 !== hash(record.requestText) ||
    record.snapshotSha256 !== hash(record.snapshotText) ||
    canonicalJson(request) !== record.requestText ||
    canonicalJson(snapshot) !== record.snapshotText ||
    canonicalJson(snapshot.request) !== record.requestText ||
    snapshot.tenantId !== record.tenantId ||
    snapshot.actorId !== record.actorId ||
    snapshot.revisionId !== record.id ||
    snapshot.previousRevisionId !== request.expectedPreviousRevisionId ||
    request.operationKey !== record.operationKey ||
    request.engagementId !== record.engagementId ||
    request.checkId !== record.checkId ||
    request.payloadSha256 !== record.payloadSha256
  )
    throw new Error('coverage_clarification_receipt_refused');
  return { record, snapshot };
}
