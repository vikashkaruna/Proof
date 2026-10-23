/**
 * Signed-in website scan report. Built only from what the authenticated
 * website connector retains: normalised page paths, content digests, form
 * field names with category hints, and which notice, consent and rights paths
 * were reachable. Findings are prompts for human review against the DPDPA
 * provision cited; they are not legal conclusions.
 */
import type { FindingSeverity, ReviewFinding } from './data-discovery-report.js';

export const AUTHENTICATED_WEBSITE_REPORT_VERSION = 'authenticated-website-report/1' as const;

export interface AuthenticatedWebsiteScanInput {
  version: 'authenticated-website-scan/1';
  baseUrl: string;
  authMode: 'form_login' | 'bearer' | 'basic';
  checkedAt: string;
  pages: {
    path: string;
    depth: number;
    contentSha256: string;
    forms: {
      method: string;
      fields: { name: string; categories: string[] }[];
      consentControl: boolean;
      purposeText: boolean;
    }[];
  }[];
  skipped: { path: string; reason: string }[];
  evidence: {
    privacyNotice: string[];
    consentControls: string[];
    accessRequest: string[];
    erasure: string[];
    correction: string[];
    grievance: string[];
    cookiesBeforeLogin: string[];
    cookiesAfterLogin: string[];
    transportSecure: boolean;
    sessionLost: boolean;
  };
}
export interface AuthenticatedWebsiteReport {
  version: typeof AUTHENTICATED_WEBSITE_REPORT_VERSION;
  organisation: string;
  system: string;
  connectorName: string;
  targetBinding: 'production' | 'sandbox' | 'reference-mock';
  baseUrl: string;
  checkedAt: string;
  summary: {
    pagesRead: number;
    pagesSkipped: number;
    personalDataForms: number;
    personalFields: number;
    categories: Record<string, number>;
  };
  rights: { key: string; label: string; paths: string[] }[];
  findings: ReviewFinding[];
  pages: AuthenticatedWebsiteScanInput['pages'];
  skipped: AuthenticatedWebsiteScanInput['skipped'];
  limitations: string[];
}

const ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

export function buildAuthenticatedWebsiteReport(input: {
  organisation: string;
  system: string;
  connectorName: string;
  targetBinding: AuthenticatedWebsiteReport['targetBinding'];
  scan: AuthenticatedWebsiteScanInput;
}): AuthenticatedWebsiteReport {
  const { scan } = input;
  const evidence = scan.evidence;
  const categories: Record<string, number> = {};
  const personalForms: {
    path: string;
    form: AuthenticatedWebsiteScanInput['pages'][number]['forms'][number];
  }[] = [];
  for (const page of scan.pages)
    for (const form of page.forms) {
      const personal = form.fields.filter((field) => field.categories.length > 0);
      if (personal.length === 0) continue;
      personalForms.push({ path: page.path, form });
      for (const field of personal)
        for (const category of field.categories)
          categories[category] = (categories[category] ?? 0) + 1;
    }
  const formsWith = (category: string) =>
    [
      ...new Set(
        personalForms
          .filter(({ form }) => form.fields.some((f) => f.categories.includes(category)))
          .map(({ path }) => path),
      ),
    ].sort();
  const findings: ReviewFinding[] = [];
  const add = (finding: ReviewFinding) => {
    if (finding.resources.length > 0) findings.push(finding);
  };
  const site = ['(signed-in area)'];
  // Demo portals run over plain HTTP on the private local network; transport
  // is assessed only for real (production-bound) sites.
  if (!evidence.transportSecure && input.targetBinding !== 'sandbox')
    add({
      id: 'transport.insecure',
      severity: 'high',
      title: 'Signed-in pages served without HTTPS',
      detail:
        'Credentials and personal data travel in clear text. Serve the whole signed-in area over HTTPS.',
      provision: 'DPDPA 2023 s.8(5) (reasonable security safeguards)',
      resources: [scan.baseUrl],
    });
  if (evidence.privacyNotice.length === 0)
    add({
      id: 'rights.no_privacy_notice',
      severity: 'high',
      title: 'No privacy notice reachable from the signed-in area',
      detail:
        'No link or page about privacy was found in the pages read. Data principals should be able to reach the notice describing the personal data and its purpose.',
      provision: 'DPDPA 2023 s.5 (notice)',
      resources: site,
    });
  if (evidence.consentControls.length === 0)
    add({
      id: 'rights.no_consent_withdrawal',
      severity: 'high',
      title: 'No way to manage or withdraw consent was found',
      detail:
        'Withdrawing consent must be as easy as giving it. No consent, preference or withdrawal page was reachable.',
      provision: 'DPDPA 2023 s.6(4) (withdrawal of consent)',
      resources: site,
    });
  const noConsentForms = personalForms.filter(
    ({ form }) => !form.consentControl && !form.purposeText,
  );
  add({
    id: 'forms.no_purpose_or_consent',
    severity: 'high',
    title: 'Personal-data forms without purpose or consent wording',
    detail:
      'These forms collect personal data but show no purpose statement, privacy reference or consent control near the fields.',
    provision: 'DPDPA 2023 s.5 (notice) and s.6(1) (specific, informed consent)',
    resources: [...new Set(noConsentForms.map(({ path }) => path))].sort(),
  });
  add({
    id: 'forms.children',
    severity: 'high',
    title: "Forms that may collect children's or guardian data",
    detail:
      'Field names suggest data about children or guardians. Confirm age assurance and verifiable parental consent.',
    provision: 'DPDPA 2023 s.9 (personal data of children)',
    resources: formsWith('children'),
  });
  if (evidence.accessRequest.length === 0)
    add({
      id: 'rights.no_access_request',
      severity: 'medium',
      title: 'No path to request a summary of personal data',
      detail: 'No data download, export or access-request page was found in the signed-in area.',
      provision: 'DPDPA 2023 s.11 (right to access information)',
      resources: site,
    });
  if (evidence.erasure.length === 0)
    add({
      id: 'rights.no_erasure',
      severity: 'medium',
      title: 'No path to request erasure',
      detail: 'No account deletion or data erasure path was found in the signed-in area.',
      provision: 'DPDPA 2023 s.12 (right to correction and erasure)',
      resources: site,
    });
  if (evidence.grievance.length === 0)
    add({
      id: 'rights.no_grievance',
      severity: 'medium',
      title: 'No grievance redressal contact found',
      detail:
        'No grievance officer, complaint or data protection officer contact was reachable from the signed-in area.',
      provision: 'DPDPA 2023 s.13 (grievance redressal) and s.8(9) (contact for questions)',
      resources: site,
    });
  add({
    id: 'forms.national_identifiers',
    severity: 'medium',
    title: 'Forms that collect identity numbers',
    detail:
      'Field names suggest PAN, Aadhaar or similar identifiers. Confirm each is necessary for the stated purpose and is masked once captured.',
    provision: 'DPDPA 2023 s.6(1) (limited to necessary data) and s.8(5) (safeguards)',
    resources: [
      ...new Set(
        personalForms
          .filter(({ form }) =>
            form.fields.some((f) => /aadhaa?r|\bpan\b|pan_|passport|voter/i.test(f.name)),
          )
          .map(({ path }) => path),
      ),
    ].sort(),
  });
  if (evidence.cookiesBeforeLogin.length > 0)
    add({
      id: 'cookies.before_sign_in',
      severity: 'low',
      title: 'Cookies set before sign-in',
      detail: `Cookies set on the anonymous visit: ${evidence.cookiesBeforeLogin.join(', ')}. Confirm each is strictly necessary or covered by consent.`,
      provision: 'DPDPA 2023 s.6 (consent) for non-essential processing',
      resources: [scan.baseUrl],
    });
  if (evidence.sessionLost || scan.skipped.some((s) => s.reason !== 'account_action_not_followed'))
    add({
      id: 'coverage.partial',
      severity: 'low',
      title: 'Part of the signed-in area was not read',
      detail: evidence.sessionLost
        ? 'The session ended during the crawl, so later pages were not read.'
        : 'Some pages could not be read; see the skipped list.',
      provision: 'Scan coverage',
      resources: scan.skipped
        .filter((s) => s.reason !== 'account_action_not_followed')
        .map((s) => s.path)
        .slice(0, 20),
    });
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id.localeCompare(b.id));
  return {
    version: AUTHENTICATED_WEBSITE_REPORT_VERSION,
    organisation: input.organisation,
    system: input.system,
    connectorName: input.connectorName,
    targetBinding: input.targetBinding,
    baseUrl: scan.baseUrl,
    checkedAt: scan.checkedAt,
    summary: {
      pagesRead: scan.pages.length,
      pagesSkipped: scan.skipped.length,
      personalDataForms: personalForms.length,
      personalFields: Object.values(categories).reduce((a, b) => a + b, 0),
      categories,
    },
    rights: [
      { key: 'privacyNotice', label: 'Privacy notice', paths: evidence.privacyNotice },
      { key: 'consentControls', label: 'Consent management', paths: evidence.consentControls },
      { key: 'accessRequest', label: 'Access request', paths: evidence.accessRequest },
      { key: 'correction', label: 'Correction', paths: evidence.correction },
      { key: 'erasure', label: 'Erasure', paths: evidence.erasure },
      { key: 'grievance', label: 'Grievance redressal', paths: evidence.grievance },
    ],
    findings,
    pages: scan.pages,
    skipped: scan.skipped,
    limitations: [
      'Only the pages reachable within the crawl bound (25 pages, two links deep) from the configured start pages were read.',
      'Links that look like account actions (log out, delete, pay, cancel) were recorded but never opened, so their content is not assessed.',
      'Field categories come from field names, not values. No page text, field value or cookie value was retained.',
      'Findings are prompts for human review against the DPDPA provisions cited. They are not legal advice and do not certify compliance.',
      ...(input.targetBinding === 'sandbox'
        ? [
            'This scan ran against a synthetic demonstration portal, not a production site. Its plain-HTTP transport is a local demo setting and is not assessed.',
          ]
        : []),
    ],
  };
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  high: 'background:#FBEAEA;color:#8A2522;border-color:#D9534F',
  medium: 'background:#E7F7F5;color:#0B6E64;border-color:#0FB5A5',
  low: 'background:#F1F3F7;color:#3B4660;border-color:#9AA3B5',
};

/** Self-contained printable HTML (no scripts, no external assets, no gold). */
export function renderAuthenticatedWebsiteReportHtml(report: AuthenticatedWebsiteReport): string {
  const e = escapeHtml;
  const findings = report.findings
    .map(
      (
        f,
      ) => `<article class="finding" style="${SEVERITY_STYLE[f.severity]}"><h3><span class="sev">${e(f.severity)}</span> ${e(f.title)}</h3>
<p>${e(f.detail)}</p><p class="meta">Check: ${e(f.provision)}</p><p class="meta">Where: ${f.resources.map(e).join(', ')}</p></article>`,
    )
    .join('\n');
  const rights = report.rights
    .map(
      (r) =>
        `<tr><td>${e(r.label)}</td><td>${r.paths.length ? r.paths.map(e).join(', ') : '<span class="missing">not found</span>'}</td></tr>`,
    )
    .join('');
  const forms = report.pages
    .flatMap((page) =>
      page.forms
        .filter((form) => form.fields.some((f) => f.categories.length))
        .map(
          (form) =>
            `<tr><td>${e(page.path)}</td><td>${form.fields
              .filter((f) => f.categories.length)
              .map((f) => `${e(f.name)} <span class="meta">(${e(f.categories.join(', '))})</span>`)
              .join(
                ', ',
              )}</td><td>${form.consentControl ? 'consent control' : form.purposeText ? 'purpose text' : '<span class="missing">none</span>'}</td></tr>`,
        ),
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed-in website scan — ${e(report.organisation)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1E2A4A;margin:32px auto;max-width:960px;padding:0 16px;line-height:1.45}
h1{margin:0 0 4px;font-size:26px}h2{border-bottom:2px solid #0FB5A5;padding-bottom:4px;margin-top:32px}
.meta{color:#5A6478;font-size:13px}.missing{color:#8A2522;font-weight:600}
.finding{border-left:4px solid;border-radius:6px;padding:10px 14px;margin:10px 0}.finding h3{margin:0 0 6px;font-size:16px}
.sev{text-transform:uppercase;font-size:11px;letter-spacing:.06em;margin-right:6px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #D6DAE3;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#F1F3F7}@media print{body{margin:0}.finding{break-inside:avoid}}
</style></head><body>
<header><p class="meta">Axiom Proof · Signed-in website scan · ${e(report.version)}</p>
<h1>${e(report.organisation)} — ${e(report.system)}</h1>
<p class="meta">Connector “${e(report.connectorName)}” · ${e(report.baseUrl)} · ${e(report.targetBinding)} · read ${e(report.checkedAt)}</p></header>
<section><h2>Summary</h2><p>${report.summary.pagesRead} pages read, ${report.summary.pagesSkipped} not opened or unavailable, ${report.summary.personalDataForms} forms collecting personal data (${report.summary.personalFields} fields).</p></section>
<section><h2>Review prompts</h2>${findings || '<p>No prompts were raised.</p>'}</section>
<section><h2>Data principal rights paths</h2><table><thead><tr><th>Right</th><th>Where found</th></tr></thead><tbody>${rights}</tbody></table></section>
<section><h2>Forms collecting personal data</h2><table><thead><tr><th>Page</th><th>Personal-data fields</th><th>Purpose or consent</th></tr></thead><tbody>${forms || '<tr><td colspan="3">None found.</td></tr>'}</tbody></table></section>
<section><h2>Limitations</h2><ul>${report.limitations.map((l) => `<li>${e(l)}</li>`).join('')}</ul></section>
</body></html>
`;
}
