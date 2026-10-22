import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuthenticatedWebsiteReport } from '@axiom/report-kit/authenticated-website-report';
import {
  crawlAuthenticatedWebsite,
  type AuthenticatedWebsiteSite,
} from './website-authenticated.js';

// Live check of the signed-in website connector against the synthetic demo
// portal (scripts/local-demo-databases.py up). The portal's published port is
// reached on 127.0.0.1 while the Host header names each company's site.
// Skipped unless AXIOM_DEMO_DATABASES_DIR points at the protected state.
const state = process.env.AXIOM_DEMO_DATABASES_DIR;
const users = state
  ? (JSON.parse(
      readFileSync(join(state, 'axiom-portal-demo', 'portal-users.json'), 'utf8'),
    ) as Record<string, { username: string; password: string }>)
  : {};

async function scan(host: string) {
  const site: AuthenticatedWebsiteSite = {
    tenantId: '78780000-0000-4000-8000-000000000001',
    connectorId: '78780000-0000-4000-8000-000000000002',
    descriptorId: '41440000-0000-4000-8000-000000000003',
    baseUrl: `http://${host}:57560`,
    startPaths: ['/account'],
    auth: {
      mode: 'form_login',
      loginPath: '/login',
      usernameField: 'email',
      passwordField: 'password',
    },
    credential: {
      id: '78780000-0000-4000-8000-000000000003',
      revision: 1,
      expiresAt: Date.now() + 60_000,
      file: '/x',
    },
    maxPages: 25,
  };
  const result = await crawlAuthenticatedWebsite(
    site,
    {
      schemaVersion: 1,
      tenantId: site.tenantId,
      connectorId: site.connectorId,
      credentialId: site.credential.id,
      revision: 1,
      expiresAt: site.credential.expiresAt,
      username: users[host]!.username,
      secret: users[host]!.password,
    },
    'sandbox',
    'local',
    AbortSignal.timeout(20_000),
    { resolve4: async () => ['127.0.0.1'] },
  );
  const report = buildAuthenticatedWebsiteReport({
    organisation: host,
    system: 'Customer portal',
    connectorName: 'portal',
    targetBinding: 'sandbox',
    scan: result,
  });
  return { result, findings: report.findings.map((f) => f.id) };
}
const accessLog = () =>
  execFileSync('docker', ['logs', 'axiom-portal-demo'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe.skipIf(!state)('signed-in website connector against the demo portals', () => {
  it('Kosha: every rights path present, consented KYC form', async () => {
    const { result, findings } = await scan('axiom-portal-kosha');
    expect(result.evidence).toMatchObject({
      privacyNotice: ['/privacy'],
      accessRequest: ['/data-request'],
      grievance: ['/grievance'],
      erasure: ['/account/delete'],
      sessionLost: false,
    });
    expect(result.evidence.consentControls).toContain('/consent-settings');
    const account = result.pages.find((p) => p.path === '/account')!.forms[0]!;
    expect(account).toMatchObject({ consentControl: true, purposeText: true });
    expect(findings.filter((f) => f.startsWith('rights.'))).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/Aarav|ABCPS1234K|9123456780/);
  });

  it("Sanjeevani: children's dependant form, no consent or access path", async () => {
    const { result, findings } = await scan('axiom-portal-sanjeevani');
    expect(result.evidence.consentControls).toEqual([]);
    expect(result.evidence.accessRequest).toEqual([]);
    expect(findings).toEqual(
      expect.arrayContaining([
        'forms.children',
        'forms.no_purpose_or_consent',
        'forms.national_identifiers',
        'rights.no_consent_withdrawal',
        'rights.no_access_request',
        'rights.no_erasure',
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(/Diya|234567890123|Penicillin/);
  });

  it('Nimbus: marketing cookie before sign-in, no privacy notice or grievance contact', async () => {
    const { result, findings } = await scan('axiom-portal-nimbus');
    expect(result.evidence.cookiesBeforeLogin).toEqual(['mkt_ref']);
    expect(result.evidence.cookiesAfterLogin).toEqual(['portal_sid']);
    expect(result.evidence.accessRequest).toEqual(['/export-data']);
    expect(result.evidence.erasure).toEqual(['/settings/close-account']);
    expect(findings).toEqual(
      expect.arrayContaining([
        'rights.no_privacy_notice',
        'rights.no_grievance',
        'cookies.before_sign_in',
      ]),
    );
  });

  it('never requested a log-out, delete or close-account page on any site', () => {
    const requests = accessLog()
      .split('\n')
      .filter((line) => /^(GET|POST) axiom-portal-/.test(line));
    expect(requests.length).toBeGreaterThan(10);
    expect(requests.filter((line) => /logout|delete|close-account/.test(line))).toEqual([]);
    expect(
      requests.filter((line) => line.startsWith('POST')).every((line) => line.endsWith(' /login')),
    ).toBe(true);
  });
});
