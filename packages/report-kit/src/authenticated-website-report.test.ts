import { describe, expect, it } from 'vitest';
import {
  buildAuthenticatedWebsiteReport,
  renderAuthenticatedWebsiteReportHtml,
  type AuthenticatedWebsiteScanInput,
} from './authenticated-website-report.js';

const scan = (
  evidence: Partial<AuthenticatedWebsiteScanInput['evidence']> = {},
): AuthenticatedWebsiteScanInput => ({
  version: 'authenticated-website-scan/1',
  baseUrl: 'http://axiom-portal-sanjeevani:8080',
  authMode: 'form_login',
  checkedAt: '2026-10-22T11:00:00.000Z',
  pages: [
    {
      path: '/account',
      depth: 0,
      contentSha256: 'a'.repeat(64),
      forms: [
        {
          method: 'post',
          fields: [
            { name: 'full_name', categories: ['identity'] },
            { name: 'aadhaar_number', categories: ['identity'] },
            { name: 'guardian_name', categories: ['children'] },
            { name: 'ward', categories: [] },
          ],
          consentControl: false,
          purposeText: false,
        },
      ],
    },
    {
      path: '/preferences',
      depth: 1,
      contentSha256: 'b'.repeat(64),
      forms: [
        {
          method: 'post',
          fields: [{ name: 'email', categories: ['contact'] }],
          consentControl: true,
          purposeText: true,
        },
      ],
    },
  ],
  skipped: [
    { path: '/logout', reason: 'account_action_not_followed' },
    { path: '/reports', reason: 'http_status' },
  ],
  evidence: {
    privacyNotice: ['/privacy'],
    consentControls: [],
    accessRequest: [],
    erasure: ['/account/delete'],
    correction: [],
    grievance: [],
    cookiesBeforeLogin: ['tracking_id'],
    cookiesAfterLogin: ['sid'],
    transportSecure: false,
    sessionLost: false,
    ...evidence,
  },
});
const build = (input = scan()) =>
  buildAuthenticatedWebsiteReport({
    organisation: 'Sanjeevani Care Hospitals (Demo · Healthcare)',
    system: 'Patient portal',
    connectorName: 'Sanjeevani portal',
    targetBinding: 'sandbox',
    scan: input,
  });

describe('signed-in website report', () => {
  it('raises rights, notice and form prompts in priority order', () => {
    const report = build();
    expect(report.findings.map((f) => f.id)).toEqual([
      'forms.children',
      'forms.no_purpose_or_consent',
      'rights.no_consent_withdrawal',
      'forms.national_identifiers',
      'rights.no_access_request',
      'rights.no_grievance',
      'cookies.before_sign_in',
      'coverage.partial',
    ]);
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    expect(byId['rights.no_consent_withdrawal']!.provision).toContain('s.6(4)');
    expect(byId['rights.no_access_request']!.provision).toContain('s.11');
    expect(byId['rights.no_grievance']!.provision).toContain('s.13');
    expect(byId['forms.no_purpose_or_consent']!.resources).toEqual(['/account']);
    expect(byId['coverage.partial']!.resources).toEqual(['/reports']);
    expect(report.summary).toMatchObject({ pagesRead: 2, personalDataForms: 2, personalFields: 4 });
  });

  it('assesses transport only for production sites', () => {
    const production = buildAuthenticatedWebsiteReport({
      organisation: 'O',
      system: 'S',
      connectorName: 'C',
      targetBinding: 'production',
      scan: scan(),
    });
    expect(production.findings.find((f) => f.id === 'transport.insecure')?.provision).toContain(
      's.8(5)',
    );
  });

  it('raises no rights prompts when every path is present over HTTPS', () => {
    const report = build(
      scan({
        consentControls: ['/preferences'],
        accessRequest: ['/data-request'],
        grievance: ['/grievance'],
        cookiesBeforeLogin: [],
        transportSecure: true,
      }),
    );
    expect(report.findings.filter((f) => f.id.startsWith('rights.'))).toEqual([]);
    expect(report.findings.some((f) => f.id === 'transport.insecure')).toBe(false);
  });

  it('renders escaped self-contained HTML without gold', () => {
    const html = renderAuthenticatedWebsiteReportHtml(
      buildAuthenticatedWebsiteReport({
        organisation: '<img src=x onerror=alert(1)>',
        system: 'Portal',
        connectorName: 'P',
        targetBinding: 'sandbox',
        scan: scan(),
      }),
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<script|<img/i);
    expect(html.toUpperCase()).not.toContain('#C9A227');
    expect(html).toContain('Data principal rights paths');
    expect(html).toContain('synthetic demonstration portal');
  });
});
