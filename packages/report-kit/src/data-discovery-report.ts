/**
 * Data discovery scan report. Built only from the metadata a Drishti SQL
 * discovery run is allowed to persist (connector_discovery_runs is
 * metadata-only): relation and column names, declared types, name-based
 * category hints and per-column counts of detected value shapes from a
 * bounded sample. No sampled value exists anywhere in this input or output.
 *
 * Findings are review prompts for a human, mapped to the DPDPA provision a
 * reviewer should check. They are not legal conclusions and never certify
 * compliance.
 */
export const DATA_DISCOVERY_REPORT_VERSION = 'data-discovery-report/1' as const;

export type PersonalDataCategory =
  'contact' | 'identity' | 'financial' | 'health' | 'employment' | 'children';

export interface DiscoveredColumn {
  name: string;
  type: string;
  nullable: boolean;
  categoryHints: string[];
}
export interface DiscoveredTable {
  resource: string;
  kind: string;
  estimatedRows: number;
  columns: DiscoveredColumn[];
  categoryHints: string[];
}
export interface SampledColumn {
  column: string;
  sampled: number;
  nonNull: number;
  detected: Record<string, number>;
  categoryHints: string[];
}
export interface DataDiscoveryReportInput {
  organisation: string;
  system: string;
  connectorName: string;
  /** Plug-in display name, e.g. "MariaDB". */
  engine: string;
  targetBinding: 'production' | 'sandbox' | 'reference-mock';
  /** When the enumerate run was recorded (ISO-8601). */
  enumeratedAt: string;
  tables: DiscoveredTable[];
  samples: Record<string, { sampledAt: string; columns: SampledColumn[] }>;
}

export type FindingSeverity = 'high' | 'medium' | 'low';
export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** DPDPA 2023 provision the reviewer should check. */
  provision: string;
  resources: string[];
}
export interface ReportColumn {
  name: string;
  type: string;
  categories: string[];
  /** Detected value shapes in the sample, e.g. { email: 180 }. */
  detected: Record<string, number>;
  sampled: number;
  nonNull: number;
}
export interface ReportTable {
  resource: string;
  estimatedRows: number;
  categories: string[];
  sampled: boolean;
  sampledAt: string | null;
  personalColumns: ReportColumn[];
  otherColumnCount: number;
}
export interface DataDiscoveryReport {
  version: typeof DATA_DISCOVERY_REPORT_VERSION;
  organisation: string;
  system: string;
  connectorName: string;
  engine: string;
  targetBinding: DataDiscoveryReportInput['targetBinding'];
  enumeratedAt: string;
  summary: {
    tables: number;
    tablesWithPersonalData: number;
    sampledTables: number;
    personalColumns: number;
    estimatedPersonalRecords: number;
    categories: Record<string, number>;
    detectedShapes: Record<string, number>;
  };
  tables: ReportTable[];
  findings: ReviewFinding[];
  limitations: string[];
}

/** Which category a detected value shape is evidence for. */
const SHAPE_CATEGORY: Record<string, PersonalDataCategory> = {
  email: 'contact',
  phone_in: 'contact',
  pan: 'identity',
  aadhaar_like: 'identity',
};
const SHAPE_LABEL: Record<string, string> = {
  email: 'email addresses',
  phone_in: 'Indian mobile numbers',
  pan: 'PAN numbers',
  aadhaar_like: 'Aadhaar-like numbers',
};
const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const add = (target: Record<string, number>, key: string, amount: number) => {
  target[key] = (target[key] ?? 0) + amount;
};

function columnCategories(hints: string[], detected: Record<string, number>): string[] {
  const fromShapes = Object.entries(detected)
    .filter(([, count]) => count > 0)
    .map(([shape]) => SHAPE_CATEGORY[shape])
    .filter((category): category is PersonalDataCategory => category !== undefined);
  return sorted([...hints, ...fromShapes]);
}

export function buildDataDiscoveryReport(input: DataDiscoveryReportInput): DataDiscoveryReport {
  const categories: Record<string, number> = {};
  const detectedShapes: Record<string, number> = {};
  const tables: ReportTable[] = [];
  // Per-category resource lists drive the category findings below.
  const byCategory = new Map<string, Set<string>>();
  const unexpected: { resource: string; column: string; shapes: string[] }[] = [];
  const unconfirmed: { resource: string; column: string }[] = [];
  const unsampled: string[] = [];

  for (const table of [...input.tables].sort((a, b) => a.resource.localeCompare(b.resource))) {
    const sample = input.samples[table.resource];
    const sampledByName = new Map(sample?.columns.map((column) => [column.column, column]) ?? []);
    const personalColumns: ReportColumn[] = [];
    for (const column of table.columns) {
      const observed = sampledByName.get(column.name);
      const detected = Object.fromEntries(
        Object.entries(observed?.detected ?? {}).filter(([, count]) => count > 0),
      );
      const columnCats = columnCategories(column.categoryHints, detected);
      if (columnCats.length === 0) continue;
      personalColumns.push({
        name: column.name,
        type: column.type,
        categories: columnCats,
        detected,
        sampled: observed?.sampled ?? 0,
        nonNull: observed?.nonNull ?? 0,
      });
      for (const [shape, count] of Object.entries(detected)) add(detectedShapes, shape, count);
      for (const category of columnCats) {
        add(categories, category, 1);
        if (!byCategory.has(category)) byCategory.set(category, new Set());
        byCategory.get(category)!.add(table.resource);
      }
      // Values that look personal in a column whose name gives no hint are the
      // classic unstructured-PII risk (notes, comments, free text).
      const surprising = Object.keys(detected).filter(
        (shape) => !column.categoryHints.includes(SHAPE_CATEGORY[shape] ?? ''),
      );
      if (surprising.length > 0 && column.categoryHints.length === 0)
        unexpected.push({ resource: table.resource, column: column.name, shapes: surprising });
      if (
        observed &&
        observed.nonNull > 0 &&
        Object.keys(detected).length === 0 &&
        column.categoryHints.some((hint) => hint === 'contact' || hint === 'identity')
      )
        unconfirmed.push({ resource: table.resource, column: column.name });
    }
    const tableCategories = sorted(personalColumns.flatMap((column) => column.categories));
    if (tableCategories.length > 0 && !sample) unsampled.push(table.resource);
    tables.push({
      resource: table.resource,
      estimatedRows: Math.max(0, Math.trunc(table.estimatedRows)),
      categories: tableCategories,
      sampled: sample !== undefined,
      sampledAt: sample?.sampledAt ?? null,
      personalColumns,
      otherColumnCount: table.columns.length - personalColumns.length,
    });
  }

  const resourcesFor = (category: string) => sorted(byCategory.get(category) ?? []);
  const findings: ReviewFinding[] = [];
  const categoryFinding = (
    category: PersonalDataCategory,
    severity: FindingSeverity,
    title: string,
    detail: string,
    provision: string,
  ) => {
    const resources = resourcesFor(category);
    if (resources.length > 0)
      findings.push({ id: `category.${category}`, severity, title, detail, provision, resources });
  };
  categoryFinding(
    'children',
    'high',
    "Possible children's or guardian data",
    'Columns suggest data about children or their guardians. Confirm whether any data principal is under 18 and, if so, that verifiable parental consent is obtained and no tracking, behavioural monitoring or targeted advertising is directed at them.',
    'DPDPA 2023 s.9 (processing of personal data of children)',
  );
  categoryFinding(
    'health',
    'high',
    'Health information stored',
    'Diagnosis, prescription or other health columns were found. Confirm the purpose, restrict access to the clinical roles that need it, and apply reasonable security safeguards proportionate to the harm a breach would cause.',
    'DPDPA 2023 s.8(5) (reasonable security safeguards) and s.4 (lawful purpose)',
  );
  categoryFinding(
    'financial',
    'high',
    'Financial identifiers stored',
    'Account, card, UPI or income columns were found. Confirm masking or tokenisation, encryption at rest and that access is limited to the stated purpose.',
    'DPDPA 2023 s.8(5) (reasonable security safeguards)',
  );
  if ((detectedShapes.aadhaar_like ?? 0) + (detectedShapes.pan ?? 0) > 0) {
    findings.push({
      id: 'shape.national_identifiers',
      severity: 'high',
      title: 'National identifier numbers present in sampled values',
      detail:
        'Sampled values match PAN or Aadhaar-like number shapes. Confirm each is necessary for the purpose, is masked where displayed, and is erased when that purpose ends.',
      provision: 'DPDPA 2023 s.8(5) (safeguards) and s.8(7) (erasure when purpose is served)',
      resources: sorted(
        tables
          .filter((table) =>
            table.personalColumns.some(
              (column) => (column.detected.pan ?? 0) + (column.detected.aadhaar_like ?? 0) > 0,
            ),
          )
          .map((table) => table.resource),
      ),
    });
  }
  if (unexpected.length > 0)
    findings.push({
      id: 'shape.unexpected_personal_values',
      severity: 'high',
      title: 'Personal data in columns not named for it',
      detail: `Values that look like ${sorted(unexpected.flatMap((u) => u.shapes))
        .map((shape) => SHAPE_LABEL[shape] ?? shape)
        .join(', ')} were found in ${unexpected
        .map((u) => `${u.resource}.${u.column}`)
        .join(
          ', ',
        )}. Free-text columns are easy to miss in notices, access requests and erasure; review what is captured there.`,
      provision: 'DPDPA 2023 s.5 (notice), s.8(7) (erasure) and s.11 (right to access information)',
      resources: sorted(unexpected.map((u) => u.resource)),
    });
  categoryFinding(
    'employment',
    'medium',
    'Employee data stored',
    'Employment columns were found. Confirm the legitimate-use basis for employment purposes and that retention follows the employment purpose.',
    'DPDPA 2023 s.7(i) (legitimate use for employment) and s.8(7) (erasure)',
  );
  const notice = sorted([...resourcesFor('contact'), ...resourcesFor('identity')]);
  if (notice.length > 0)
    findings.push({
      id: 'inventory.notice_and_consent',
      severity: 'medium',
      title: 'Personal data inventory to reconcile with notices',
      detail:
        'These relations hold contact or identity data. Confirm each is covered by a notice that names the data and purpose, and by consent or another lawful basis.',
      provision: 'DPDPA 2023 s.5 (notice) and s.6 (consent)',
      resources: notice,
    });
  if (unconfirmed.length > 0)
    findings.push({
      id: 'coverage.unconfirmed_hints',
      severity: 'low',
      title: 'Column names suggest personal data the sample did not confirm',
      detail: `${unconfirmed.map((u) => `${u.resource}.${u.column}`).join(', ')}: the name suggests contact or identity data but no sampled value matched a known shape. Confirm the content or format manually.`,
      provision: 'Inventory accuracy (supports DPDPA 2023 s.8(3) completeness and accuracy)',
      resources: sorted(unconfirmed.map((u) => u.resource)),
    });
  if (unsampled.length > 0)
    findings.push({
      id: 'coverage.unsampled',
      severity: 'low',
      title: 'Relations with personal-data hints that were not sampled',
      detail:
        'Only column names were reviewed for these relations. Run a sample to confirm what they hold.',
      provision: 'Scan coverage',
      resources: unsampled,
    });
  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );

  const personalTables = tables.filter((table) => table.personalColumns.length > 0);
  return {
    version: DATA_DISCOVERY_REPORT_VERSION,
    organisation: input.organisation,
    system: input.system,
    connectorName: input.connectorName,
    engine: input.engine,
    targetBinding: input.targetBinding,
    enumeratedAt: input.enumeratedAt,
    summary: {
      tables: tables.length,
      tablesWithPersonalData: personalTables.length,
      sampledTables: tables.filter((table) => table.sampled).length,
      personalColumns: personalTables.reduce((n, table) => n + table.personalColumns.length, 0),
      estimatedPersonalRecords: personalTables.reduce((n, table) => n + table.estimatedRows, 0),
      categories,
      detectedShapes,
    },
    tables,
    findings,
    limitations: [
      'Categories come from column names and from value shapes detected in a bounded sample (at most 200 rows per relation). Absence of a finding does not show absence of personal data.',
      'Only relations the read-only discovery account can see are covered. Row counts are engine estimates.',
      'No sampled value was retained, transmitted or shown; only counts of matching value shapes.',
      'Findings are prompts for human review against the DPDPA provisions cited. They are not legal advice and do not certify compliance.',
      ...(input.targetBinding === 'sandbox'
        ? ['This scan ran against a synthetic demonstration database, not a production system.']
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

/** Self-contained printable HTML (no scripts, no external assets). Uses the
 * indigo/teal/ember palette only: nothing here is sealed, so no gold. */
export function renderDataDiscoveryReportHtml(report: DataDiscoveryReport): string {
  const e = escapeHtml;
  const counts = (values: Record<string, number>) =>
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => `${e(key)} ${count}`)
      .join(' · ') || 'none';
  const findings = report.findings
    .map(
      (finding) => `<article class="finding" style="${SEVERITY_STYLE[finding.severity]}">
  <h3><span class="sev">${e(finding.severity)}</span> ${e(finding.title)}</h3>
  <p>${e(finding.detail)}</p>
  <p class="meta">Check: ${e(finding.provision)}</p>
  <p class="meta">Relations: ${finding.resources.map(e).join(', ')}</p>
</article>`,
    )
    .join('\n');
  const rows = report.tables
    .filter((table) => table.personalColumns.length > 0)
    .map((table) =>
      table.personalColumns
        .map(
          (column, index) => `<tr>
  ${index === 0 ? `<td rowspan="${table.personalColumns.length}">${e(table.resource)}<br><span class="meta">~${table.estimatedRows} rows${table.sampled ? '' : ' · not sampled'}</span></td>` : ''}
  <td>${e(column.name)}</td><td>${e(column.categories.join(', '))}</td>
  <td>${column.sampled ? `${counts(column.detected)} <span class="meta">of ${column.nonNull}/${column.sampled}</span>` : '<span class="meta">not sampled</span>'}</td>
</tr>`,
        )
        .join('\n'),
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data discovery scan — ${e(report.organisation)} — ${e(report.system)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1E2A4A;margin:32px auto;max-width:960px;padding:0 16px;line-height:1.45}
h1{margin:0 0 4px;font-size:26px}h2{border-bottom:2px solid #0FB5A5;padding-bottom:4px;margin-top:32px}
.meta{color:#5A6478;font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{border:1px solid #D6DAE3;border-radius:8px;padding:12px}.stat b{display:block;font-size:24px}
.finding{border-left:4px solid;border-radius:6px;padding:10px 14px;margin:10px 0}.finding h3{margin:0 0 6px;font-size:16px}
.sev{text-transform:uppercase;font-size:11px;letter-spacing:.06em;margin-right:6px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #D6DAE3;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#F1F3F7}@media print{body{margin:0}.finding{break-inside:avoid}}
</style></head><body>
<header><p class="meta">Axiom Proof · Data discovery scan · ${e(report.version)}</p>
<h1>${e(report.organisation)} — ${e(report.system)}</h1>
<p class="meta">${e(report.engine)} connector “${e(report.connectorName)}” · ${e(report.targetBinding)} · catalogue read ${e(report.enumeratedAt)}</p></header>
<section><h2>Summary</h2><div class="grid">
<div class="stat"><b>${report.summary.tables}</b>relations scanned</div>
<div class="stat"><b>${report.summary.tablesWithPersonalData}</b>hold personal data</div>
<div class="stat"><b>${report.summary.personalColumns}</b>personal-data columns</div>
<div class="stat"><b>${report.summary.sampledTables}</b>relations sampled</div>
<div class="stat"><b>${report.findings.filter((f) => f.severity === 'high').length}</b>high-priority prompts</div>
</div>
<p class="meta">Categories: ${counts(report.summary.categories)}</p>
<p class="meta">Detected value shapes: ${counts(report.summary.detectedShapes)}</p></section>
<section><h2>Review prompts</h2>${findings || '<p>No prompts were raised.</p>'}</section>
<section><h2>Personal data inventory</h2>
<table><thead><tr><th>Relation</th><th>Column</th><th>Categories</th><th>Detected in sample</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No personal-data columns were identified.</td></tr>'}</tbody></table></section>
<section><h2>Limitations</h2><ul>${report.limitations.map((l) => `<li>${e(l)}</li>`).join('')}</ul></section>
</body></html>
`;
}
