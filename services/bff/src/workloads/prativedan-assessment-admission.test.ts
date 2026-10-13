/** Real locally signed JWTs and synthetic trusted journals; no deployed admission proof. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentName,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
} from '@axiom/types';
import { sourceFixture } from '../services/prativedan-draft.test-fixture.js';
import { prativedanTextHash } from '../services/prativedan-draft-source.js';
import {
  PrativedanAssessmentAdmissionPreflight,
  PrativedanAssessmentAdmissionRefused,
} from './prativedan-assessment-admission.js';
const domain = 'local.axiomproof.test';
const subject = `spiffe://${domain}/agent/prativedan`;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const foreignKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  headers: Record<string, unknown> = {},
  privateKey = keys.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const input =
    encode({ alg: 'ES256', kid: 'current', typ: 'JWT', ...headers }) +
    '.' +
    encode({
      sub: subject,
      aud: ['axiom-prativedan-assessment-tools'],
      iat: now,
      exp: now + 300,
      ...claims,
    });
  return (
    input +
    '.' +
    sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
      'base64url',
    )
  );
}
function fixture() {
  const f = sourceFixture();
  const { request_id: _request, ...oldSource } = f.source;
  const source = {
    ...oldSource,
    schema_version: 2,
    kind: 'prativedan_assessment_source',
    source_id: f.ids.assessment_run_id,
    title: 'Completed assessment source',
    limitations: [
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.',
    ],
  };
  const sourceText = JSON.stringify(source, null, 1);
  const requestText = JSON.stringify(
    { ...f.request, expectedSourceSha256: prativedanTextHash(sourceText) },
    null,
    1,
  );
  const journal = {
    schema_version: 2,
    kind: 'prativedan_unpublished_draft',
    tenant_id: f.ids.tenant_id,
    actor_id: f.ids.tenant_id,
    engagement_id: f.ids.engagement_id,
    source_id: f.ids.assessment_run_id,
    assessment_run_id: f.ids.assessment_run_id,
    operation_key: f.ids.operation_key,
    run_id: f.ids.run_id,
    source_text: sourceText,
    source_sha256: prativedanTextHash(sourceText),
    request_text: requestText,
    request_sha256: prativedanTextHash(requestText),
    renderer_config_version: PRATIVEDAN_RENDERER_CONFIG_VERSION,
    renderer_config_text: PRATIVEDAN_RENDERER_CONFIG_TEXT,
    renderer_config_sha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
    requested_receipt: { id: '4', entry_hash: 'a'.repeat(64) },
    state: 'requested',
    publication_allowed: false,
    review_required: true,
    citation_verification: 'unverified_references',
  };
  const selection = {
    tenantId: journal.tenant_id,
    operationKey: journal.operation_key,
    runId: journal.run_id,
    requestSha256: journal.request_sha256,
    sourceSha256: journal.source_sha256,
  };
  const context = {
    tenantId: journal.tenant_id,
    actorId: journal.actor_id,
    sessionId: f.ids.engagement_id,
  };
  const registration: {
    id: string;
    tenant_id: string;
    agent_name: AgentName;
    spiffe_id: string;
    status: 'active';
    version: number;
  } = {
    id: f.ids.source_id,
    tenant_id: journal.tenant_id,
    agent_name: AgentName.PRATIVEDAN,
    spiffe_id: subject,
    status: 'active' as const,
    version: 1,
  };
  const bundle = {
    revision: 'current',
    validUntil: Date.now() + 600000,
    jwks: {
      keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'current', use: 'jwt-svid' }],
    },
  };
  const ports = {
    trust: { load: vi.fn(async () => bundle), stillCurrent: vi.fn(async () => true) },
    registrations: {
      find: vi.fn<(tenantId: string, spiffeId: string) => Promise<unknown>>(
        async () => registration,
      ),
    },
    resolveCurrentHuman: vi.fn(async () => context),
    authorizeCurrentHuman: vi.fn(async () => {}),
    isKilled: vi.fn(async () => false),
    loadOriginalRequestedJournal: vi.fn(async () => ({
      journal: structuredClone(journal),
      reviewedRequestText: requestText,
    })),
  };
  return {
    journal,
    requestText,
    selection,
    context,
    registration,
    bundle,
    ports,
    preflight: new PrativedanAssessmentAdmissionPreflight({ trustDomain: domain }, ports),
  };
}
describe('dedicated Prativedan assessment preflight only', () => {
  it.each([undefined, null, 0, -1, 1.5, 2147483648, '1'])(
    'refuses absent/malformed registration version %j',
    async (version) => {
      const f = fixture();
      f.ports.registrations.find.mockResolvedValue({ ...f.registration, version });
      await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
        PrativedanAssessmentAdmissionRefused,
      );
      expect(f.ports.resolveCurrentHuman).not.toHaveBeenCalled();
    },
  );
  it('refuses missing registration before any human/source lookup', async () => {
    const f = fixture();
    f.ports.registrations.find.mockResolvedValue(null);
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
    expect(f.ports.resolveCurrentHuman).not.toHaveBeenCalled();
  });
  it('refuses trust revocation during second registration await', async () => {
    const f = fixture();
    let calls = 0;
    f.ports.registrations.find.mockImplementation(async () => {
      if (++calls === 2) f.ports.trust.stillCurrent.mockResolvedValue(false);
      return f.registration;
    });
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('refuses active disable/re-enable ABA with an incremented lifecycle version', async () => {
    const f = fixture();
    let calls = 0;
    f.ports.registrations.find.mockImplementation(async () => {
      if (++calls === 2) f.registration.version += 2;
      return { ...f.registration };
    });
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('refuses kill activated during second registration await', async () => {
    const f = fixture();
    let calls = 0;
    f.ports.registrations.find.mockImplementation(async () => {
      if (++calls === 2) f.ports.isKilled.mockResolvedValue(true);
      return f.registration;
    });
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('refuses registration removed during final human await', async () => {
    const f = fixture();
    let calls = 0;
    f.ports.authorizeCurrentHuman.mockImplementation(async () => {
      if (++calls === 4) f.ports.registrations.find.mockResolvedValue(null);
    });
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('validates real signatures and trusted source twice without granting claim/tools', async () => {
    const f = fixture();
    const result = await f.preflight.check(token(), f.selection);
    expect(result).toMatchObject({
      preflight_only: true,
      claim_authorized: false,
      tool_authorized: false,
      publication_allowed: false,
    });
    expect(result.identity).toMatchObject({
      spiffeId: subject,
      tenantId: f.selection.tenantId,
      agentName: AgentName.PRATIVEDAN,
    });
    expect(f.ports.loadOriginalRequestedJournal).toHaveBeenCalledTimes(2);
    expect(f.ports.registrations.find).toHaveBeenCalledTimes(3);
    expect(f.ports.authorizeCurrentHuman).toHaveBeenCalledTimes(4);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    { sub: `spiffe://${domain}/agent/parikshan` },
    { sub: 'spiffe://foreign.test/agent/prativedan' },
    { aud: ['axiom-assessment-tools'] },
    { aud: ['axiom-prativedan-assessment-tools', 'other'] },
    { exp: Math.floor(Date.now() / 1000) + 301 },
    { exp: Math.floor(Date.now() / 1000) - 1 },
  ])('refuses wrong identity/lifetime %j', async (claims) => {
    const f = fixture();
    await expect(f.preflight.check(token(claims), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
    expect(f.ports.loadOriginalRequestedJournal).not.toHaveBeenCalled();
    expect(f.ports.resolveCurrentHuman).not.toHaveBeenCalled();
    expect(f.ports.authorizeCurrentHuman).not.toHaveBeenCalled();
    expect(f.ports.registrations.find).not.toHaveBeenCalled();
  });
  it.each([
    { jwk: keys.publicKey.export({ format: 'jwk' }) },
    { jku: 'https://foreign.test/keys' },
    { kid: 'missing' },
  ])('refuses token key material %j', async (headers) => {
    const f = fixture();
    await expect(f.preflight.check(token({}, headers), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('refuses a foreign signing key before reading source', async () => {
    const f = fixture();
    await expect(
      f.preflight.check(token({}, {}, foreignKeys.privateKey), f.selection),
    ).rejects.toThrow(PrativedanAssessmentAdmissionRefused);
    expect(f.ports.loadOriginalRequestedJournal).not.toHaveBeenCalled();
    expect(f.ports.resolveCurrentHuman).not.toHaveBeenCalled();
    expect(f.ports.authorizeCurrentHuman).not.toHaveBeenCalled();
    expect(f.ports.registrations.find).not.toHaveBeenCalled();
  });
  it.each([
    'tenant',
    'agent',
    'registration',
    'version',
    'bundle',
    'revocation',
    'kill',
    'human',
    'actor',
    'session',
    'source',
    'request',
    'state',
  ] as const)('refuses %s changed during asynchronous source loading', async (mutation) => {
    const f = fixture();
    let reads = 0;
    f.ports.loadOriginalRequestedJournal.mockImplementation(async () => {
      reads++;
      if (reads === 1) {
        if (mutation === 'tenant') f.registration.tenant_id = f.context.sessionId;
        if (mutation === 'agent') f.registration.agent_name = AgentName.PARIKSHAN;
        if (mutation === 'registration') f.registration.id = f.context.sessionId;
        if (mutation === 'version') f.registration.version++;
        if (mutation === 'bundle') f.bundle.revision = 'rotated';
        if (mutation === 'revocation') f.ports.trust.stillCurrent.mockResolvedValue(false);
        if (mutation === 'kill') f.ports.isKilled.mockResolvedValue(true);
        if (mutation === 'human')
          f.ports.authorizeCurrentHuman.mockRejectedValue(new Error('sensitive synthetic error'));
        if (mutation === 'actor') f.context.actorId = f.context.sessionId;
        if (mutation === 'session') f.context.sessionId = f.selection.runId;
      }
      const journal = structuredClone(f.journal);
      if (reads === 2) {
        if (mutation === 'source') journal.source_text += ' ';
        if (mutation === 'request') journal.request_text += ' ';
        if (mutation === 'state') journal.state = 'invocation_uncertain';
      }
      return { journal, reviewedRequestText: f.requestText };
    });
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      'Prativedan assessment preflight refused.',
    );
  });
  it('rechecks human authority after final registration await', async () => {
    const f = fixture();
    let calls = 0;
    f.ports.registrations.find.mockImplementation(async () => {
      if (++calls === 2) f.ports.authorizeCurrentHuman.mockRejectedValue(new Error('revoked'));
      return f.registration;
    });
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('refuses missing/expired trust and missing registration', async () => {
    const f = fixture();
    f.bundle.validUntil = Date.now() - 1;
    await expect(f.preflight.check(token(), f.selection)).rejects.toThrow(
      PrativedanAssessmentAdmissionRefused,
    );
  });
  it('refuses absent policy and unknown caller authority fields', async () => {
    const f = fixture();
    expect(() => new PrativedanAssessmentAdmissionPreflight({}, f.ports)).toThrow();
    await expect(
      f.preflight.check(token(), { ...f.selection, actorId: f.context.actorId }),
    ).rejects.toThrow(PrativedanAssessmentAdmissionRefused);
    expect(f.ports.authorizeCurrentHuman).not.toHaveBeenCalled();
  });
});
