import { describe, expect, it } from 'vitest';
import {
  AcceptInvitationRequestSchema,
  AdvanceOnboardingWizardRequestSchema,
  AssessmentSnapshotSchema,
  ConnectorManifestSchema,
  ContactSubmitSchema,
  CreateInvitationRequestSchema,
  ExecutePlanRequestSchema,
  GapScanSubmitSchema,
  IssueApprovalRequestSchema,
  IssueConnectorGrantRequestSchema,
  IssueMfaChallengeRequestSchema,
  RunDryRunRequestSchema,
} from './index';

const planId = '00000000-0000-4000-8000-000000000001';
const actionId = '00000000-0000-4000-8000-000000000002';
const secondActionId = '00000000-0000-4000-8000-000000000003';

function approval(actionIds = [actionId]) {
  return { planId, actionIds };
}

describe('shared boundary contracts', () => {
  it('refuses duplicate approval and execution scopes before a token is accepted', () => {
    expect(IssueApprovalRequestSchema.safeParse(approval([actionId, actionId])).success).toBe(false);
    expect(IssueApprovalRequestSchema.safeParse(approval([actionId, secondActionId])).success).toBe(true);
    expect(ExecutePlanRequestSchema.safeParse({ ...approval([actionId, actionId]), approvalToken: 'signed' }).success).toBe(false);
    expect(ExecutePlanRequestSchema.safeParse({ ...approval(), approvalToken: 'signed' })).toMatchObject({ success: true });
    expect(RunDryRunRequestSchema.safeParse({ actionIds: [] }).success).toBe(false);
    expect(RunDryRunRequestSchema.parse({ actionIds: [actionId] })).toMatchObject({ waitForCompletion: false, waitTimeoutSeconds: 60 });
  });

  it('requires an MFA challenge to identify the exact plan and action set', () => {
    expect(IssueMfaChallengeRequestSchema.safeParse({ purpose: 'approval_issuance' }).success).toBe(false);
    expect(IssueMfaChallengeRequestSchema.safeParse({ purpose: 'approval_issuance', planId, actionIds: [actionId, actionId] }).success).toBe(false);
    expect(IssueMfaChallengeRequestSchema.parse({ purpose: 'approval_issuance', planId, actionIds: [actionId] })).toMatchObject({ planId, actionIds: [actionId] });
    expect(IssueMfaChallengeRequestSchema.parse({ purpose: 'login' })).toMatchObject({ purpose: 'login' });
  });

  it('keeps invitation roles and approval scopes inside client-authorised boundaries', () => {
    expect(CreateInvitationRequestSchema.safeParse({ email: 'a@example.com', role: 'founder' }).success).toBe(false);
    expect(CreateInvitationRequestSchema.safeParse({ email: 'a@example.com', role: 'viewer', approvalScopes: ['execute'] }).success).toBe(false);
    expect(CreateInvitationRequestSchema.parse({ email: ' APPROVER@example.com ', role: 'approver', approvalScopes: ['execute'] })).toMatchObject({
      email: 'approver@example.com', role: 'approver', ttlHours: 72,
    });
    expect(AcceptInvitationRequestSchema.safeParse({ token: 'short' }).success).toBe(false);
    expect(AcceptInvitationRequestSchema.safeParse({ token: 'a'.repeat(43) }).success).toBe(true);
  });

  it('validates onboarding and grant attestations as human-scoped inputs', () => {
    expect(AdvanceOnboardingWizardRequestSchema.safeParse({ step: 'grants', expectedVersion: 1, acknowledged: false }).success).toBe(false);
    expect(AdvanceOnboardingWizardRequestSchema.safeParse({ step: 'readiness', expectedVersion: 1, confirmed: true }).success).toBe(true);
    expect(AdvanceOnboardingWizardRequestSchema.safeParse({ step: 'estate', expectedVersion: 0, estateId: planId }).success).toBe(false);
    const grant = { connectorId: planId, workloadIdentityId: actionId, scope: 'connector.write', targetScopes: ['records'], ttlDays: 7 };
    expect(IssueConnectorGrantRequestSchema.safeParse(grant).success).toBe(true);
    expect(IssueConnectorGrantRequestSchema.safeParse({ ...grant, targetScopes: ['records', 'records'] }).success).toBe(false);
    expect(IssueConnectorGrantRequestSchema.safeParse({ ...grant, targetScopes: ['records\nadmin'] }).success).toBe(false);
  });

  it('refuses executable URLs and non-production writes in declarative connector manifests', () => {
    const manifest = {
      schemaVersion: 1,
      id: planId,
      target: 'reference-postgres',
      version: '1.0.0',
      transport: 'rest',
      targetBinding: 'reference-mock',
      auth: 'oauth2.client_credentials',
      assurance: 'high',
      capabilities: { enumerate: { operation: 'list', mutating: false } },
      dataCategoryHints: [],
      rest: { resources: { people: { path: '/v1/people', itemsPointer: '/items', pageSizeParam: 'limit' } } },
      rateLimit: { requestsPerSecond: 10, burst: 10 },
    };
    expect(ConnectorManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ConnectorManifestSchema.safeParse({ ...manifest, rest: { resources: { people: { ...manifest.rest.resources.people, path: '/v1/../secrets' } } } }).success).toBe(false);
    expect(ConnectorManifestSchema.safeParse({ ...manifest, capabilities: { ...manifest.capabilities, write: { operation: 'delete', mutating: true, requiresApprovalToken: true } } }).success).toBe(false);
    expect(ConnectorManifestSchema.safeParse({ ...manifest, auth: 'legacy_static', assurance: 'high' }).success).toBe(false);
  });

  it('bounds public inputs and assessment scores', () => {
    expect(ContactSubmitSchema.safeParse({ name: 'X', email: 'bad', message: 'short' }).success).toBe(false);
    expect(GapScanSubmitSchema.parse({ sessionId: 'session-long', answers: {} })).toMatchObject({ followUpRequested: false, marketingConsent: false });
    expect(GapScanSubmitSchema.safeParse({ sessionId: 'short', answers: {} }).success).toBe(false);
    const snapshot = { tenantId: planId, engagement: null, isSdf: false, exposureInr: null,
      controls: [{ id: 'control', name: 'Control', domain: 'privacy', cite: 'Rule', score: 101, status: 'fail', evidenceIds: [] }],
      summary: { pass: 0, partial: 0, fail: 1, unassessed: 0 } };
    expect(AssessmentSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(AssessmentSnapshotSchema.safeParse({ ...snapshot, controls: [{ ...snapshot.controls[0], score: 100 }] }).success).toBe(true);
  });
});
