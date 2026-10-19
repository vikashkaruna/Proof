import { dataFlowContext, type DataFlowContext } from '@axiom/types';
import type { DataFlowJournal } from './flow-journal';
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const hash = 'a'.repeat(64);
export function fixture() {
  const pin = { systemId: id(10), estateId: id(11), version: 1, contentSha256: hash };
  const journal: DataFlowJournal = {
    version: 1,
    tenantId: id(3),
    actorId: id(1),
    challengeId: null,
    challengeExpiresAt: null,
    intent: {
      phase: 'declare',
      request: {
        schemaVersion: 1,
        operationKey: id(30),
        flowId: id(31),
        previousRevisionId: null,
        origin: pin,
        destination: { kind: 'unknown', reason: 'Destination is not yet established.' },
        purpose: null,
        dataCategories: null,
        originCountry: null,
        destinationCountries: null,
        crossBorder: null,
        transferSafeguards: null,
        sourceRopaId: null,
        sourceNote: 'Synthetic metadata only; no personal values.',
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        reason: 'Synthetic declaration metadata reviewed carefully.',
      },
    },
  };
  const context: DataFlowContext = dataFlowContext.parse({
    tenantId: id(3),
    actorId: id(1),
    checkedAt: new Date().toISOString(),
    canPrepare: true,
    canReview: true,
    systems: [{ name: 'Synthetic source', pin }],
    parties: [],
    revisions: [],
    historyHasMore: false,
  });
  return { journal, context, source: pin };
}
export const binding = (v: DataFlowJournal) => ({
  tenantId: v.tenantId,
  actorId: v.actorId,
  phase: v.intent.phase,
  operationKey: v.intent.request.operationKey,
});
