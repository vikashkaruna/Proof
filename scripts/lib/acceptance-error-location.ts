/** Publish only locations in the reviewed acceptance specifications. */
const knownSpecs = new Set([
  'agent-ui-communication.spec.ts',
  'approval-archive-provider.spec.ts',
  'approval-console.spec.ts',
  'approval-end-to-end.spec.ts',
  'approval-export-boundary.spec.ts',
  'assessment-creation.spec.ts',
  'assessment-provenance.spec.ts',
  'board-reports-provider.spec.ts',
  'classification-reviews.spec.ts',
  'connector-lifecycle.spec.ts',
  'consent-workflow.spec.ts',
  'dsar-workflow.spec.ts',
  'estate-graph.spec.ts',
  'estate-management.spec.ts',
  'evidence-ingestion.spec.ts',
  'evidence-packs-access.spec.ts',
  'evidence-packs.spec.ts',
  'evidence-vault.spec.ts',
  'gap-scan.spec.ts',
  'header-alignment.spec.ts',
  'invitations.spec.ts',
  'mfa-enrolment.spec.ts',
  'module-context.spec.ts',
  'onboarding-proposals.spec.ts',
  'onboarding-setup.spec.ts',
  'operator-navigation.spec.ts',
  'persona-journeys.spec.ts',
  'portal-provenance.spec.ts',
  'pramaan-boundary.spec.ts',
  'public-source-workflow-ui.spec.ts',
  'public-website-live.spec.ts',
  'public-website-ui.spec.ts',
  'reports.spec.ts',
  'security.spec.ts',
  'source-bound-formats-provider.spec.ts',
  'statutory-report-boundary.spec.ts',
  'tenant-bridge.spec.ts',
]);

export function acceptanceErrorLocation(location: unknown): string | undefined {
  if (!location || typeof location !== 'object') return undefined;
  const { file, line, column } = location as Record<string, unknown>;
  if (
    typeof file !== 'string' ||
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(column) ||
    (line as number) <= 0 ||
    (column as number) <= 0
  )
    return undefined;
  const match = /(?:^|\/)tests\/e2e\/tests\/([^/]+)$/.exec(file);
  if (!match?.[1] || !knownSpecs.has(match[1])) return undefined;
  return `tests/e2e/tests/${match[1]}:${line}:${column}`;
}
