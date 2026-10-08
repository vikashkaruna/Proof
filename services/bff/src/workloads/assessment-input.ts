import { canonicalJson } from '@axiom/ledger';
import type { AssessmentRequest } from '@axiom/types';

/** Enqueue and cancellation use the exact same pinned declaration encoding. */
export function canonicalAssessmentInput(
  tenantId: string,
  engagementId: string,
  libraryVersion: string,
  input: AssessmentRequest,
): string {
  return canonicalJson({
    tenant_id: tenantId,
    engagement_id: engagementId,
    library_version: libraryVersion,
    answers: input.answers,
    sdf_self_attested: input.applicability.sdfSelfAttested,
    processes_children: input.applicability.processesChildren,
    processes_health: input.applicability.processesHealth,
  });
}
