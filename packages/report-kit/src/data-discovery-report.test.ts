import { describe, expect, it } from 'vitest';
import {
  buildDataDiscoveryReport,
  renderDataDiscoveryReportHtml,
  type DataDiscoveryReportInput,
} from './data-discovery-report.js';

const column = (name: string, categoryHints: string[] = [], type = 'text') => ({
  name,
  type,
  nullable: true,
  categoryHints,
});
const sampled = (columnName: string, detected: Record<string, number>, hints: string[] = []) => ({
  column: columnName,
  sampled: 200,
  nonNull: 200,
  detected,
  categoryHints: hints,
});

function input(overrides: Partial<DataDiscoveryReportInput> = {}): DataDiscoveryReportInput {
  return {
    organisation: 'Sanjeevani Care Hospitals (Demo · Healthcare)',
    system: 'Hospital information system',
    connectorName: 'HIS MySQL',
    engine: 'MySQL',
    targetBinding: 'sandbox',
    enumeratedAt: '2026-10-22T10:00:00.000Z',
    tables: [
      {
        resource: 'his.patients',
        kind: 'r',
        estimatedRows: 240,
        columns: [
          column('id', [], 'int'),
          column('full_name', ['identity']),
          column('email', ['contact']),
          column('mobile', ['contact']),
          column('notes'),
        ],
        categoryHints: ['contact', 'identity'],
      },
      {
        resource: 'his.guardians',
        kind: 'r',
        estimatedRows: 60,
        columns: [column('guardian_name', ['children', 'identity']), column('child_dob')],
        categoryHints: ['children', 'identity'],
      },
      {
        resource: 'his.diagnoses',
        kind: 'r',
        estimatedRows: 500,
        columns: [column('diagnosis_code', ['health']), column('patient_id', [], 'int')],
        categoryHints: ['health'],
      },
      {
        resource: 'his.wards',
        kind: 'r',
        estimatedRows: 12,
        columns: [column('ward_name'), column('floor', [], 'int')],
        categoryHints: [],
      },
    ],
    samples: {
      'his.patients': {
        sampledAt: '2026-10-22T10:01:00.000Z',
        columns: [
          sampled('id', {}),
          sampled('full_name', {}, ['identity']),
          sampled('email', { email: 198 }, ['contact']),
          sampled('mobile', {}, ['contact']),
          // Free text that holds phone numbers and PAN shapes.
          sampled('notes', { phone_in: 14, pan: 3 }),
        ],
      },
      'his.wards': { sampledAt: '2026-10-22T10:02:00.000Z', columns: [sampled('ward_name', {})] },
    },
    ...overrides,
  };
}

describe('data discovery scan report', () => {
  it('builds a personal-data inventory from names and sampled value shapes', () => {
    const report = buildDataDiscoveryReport(input());
    expect(report.summary).toMatchObject({
      tables: 4,
      tablesWithPersonalData: 3,
      sampledTables: 2,
      estimatedPersonalRecords: 800,
      detectedShapes: { email: 198, phone_in: 14, pan: 3 },
    });
    const patients = report.tables.find((t) => t.resource === 'his.patients')!;
    expect(patients.personalColumns.map((c) => c.name)).toEqual([
      'full_name',
      'email',
      'mobile',
      'notes',
    ]);
    // Shapes promote an unnamed column into the inventory with their category.
    expect(patients.personalColumns.find((c) => c.name === 'notes')?.categories).toEqual([
      'contact',
      'identity',
    ]);
    expect(report.tables.find((t) => t.resource === 'his.wards')?.personalColumns).toEqual([]);
  });

  it('raises prioritised DPDPA review prompts', () => {
    const report = buildDataDiscoveryReport(input());
    const ids = report.findings.map((f) => f.id);
    expect(ids).toEqual([
      'category.children',
      'category.health',
      'shape.national_identifiers',
      'shape.unexpected_personal_values',
      'inventory.notice_and_consent',
      'coverage.unconfirmed_hints',
      'coverage.unsampled',
    ]);
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    expect(byId['category.children']!.provision).toContain('s.9');
    expect(byId['shape.unexpected_personal_values']!.detail).toContain('his.patients.notes');
    expect(byId['shape.national_identifiers']!.resources).toEqual(['his.patients']);
    expect(byId['coverage.unconfirmed_hints']!.detail).toContain('his.patients.mobile');
    expect(byId['coverage.unsampled']!.resources).toEqual(['his.diagnoses', 'his.guardians']);
    expect(report.findings.every((f) => f.resources.length > 0)).toBe(true);
  });

  it('marks synthetic sandbox scans and never claims compliance', () => {
    const report = buildDataDiscoveryReport(input());
    expect(report.limitations.join(' ')).toContain('synthetic demonstration database');
    expect(report.limitations.join(' ')).toContain('do not certify compliance');
    const production = buildDataDiscoveryReport(input({ targetBinding: 'production' }));
    expect(production.limitations.join(' ')).not.toContain('synthetic');
  });

  it('raises nothing for a catalogue without personal data', () => {
    const report = buildDataDiscoveryReport(
      input({
        tables: [input().tables[3]!],
        samples: { 'his.wards': input().samples['his.wards']! },
      }),
    );
    expect(report.findings).toEqual([]);
    expect(report.summary.tablesWithPersonalData).toBe(0);
  });

  it('renders escaped, self-contained HTML without gold or scripts', () => {
    const html = renderDataDiscoveryReportHtml(
      buildDataDiscoveryReport(input({ organisation: '<script>alert(1)</script> & Co' })),
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.toUpperCase()).not.toContain('#C9A227');
    expect(html).toContain('Personal data inventory');
    expect(html).toContain('his.patients');
  });
});
