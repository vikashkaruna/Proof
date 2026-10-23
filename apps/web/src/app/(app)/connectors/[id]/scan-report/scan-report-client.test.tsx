// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScanReportClient } from './scan-report-client';

const id = (n: number) => `75750000-0000-4000-8000-${String(n).padStart(12, '0')}`;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const report = {
  version: 'data-discovery-report/1',
  organisation: 'Sanjeevani Care Hospitals (Demo · Healthcare)',
  system: 'Hospital Information System (MySQL)',
  connectorName: 'Sanjeevani HIS — MySQL',
  engine: 'MySQL',
  targetBinding: 'sandbox',
  enumeratedAt: '2026-10-22T10:00:00.000Z',
  summary: {
    tables: 7,
    tablesWithPersonalData: 5,
    sampledTables: 7,
    personalColumns: 14,
    estimatedPersonalRecords: 1200,
    categories: { contact: 5, health: 2, children: 2 },
    detectedShapes: { email: 200, phone_in: 245 },
  },
  tables: [
    {
      resource: 'his.patients',
      estimatedRows: 260,
      categories: ['contact', 'identity'],
      sampled: true,
      sampledAt: '2026-10-22T10:01:00.000Z',
      personalColumns: [
        {
          name: 'email',
          type: 'varchar(160)',
          categories: ['contact'],
          detected: { email: 200 },
          sampled: 200,
          nonNull: 200,
        },
      ],
      otherColumnCount: 3,
    },
  ],
  findings: [
    {
      id: 'category.children',
      severity: 'high',
      title: "Possible children's or guardian data",
      detail: 'Confirm verifiable parental consent.',
      provision: 'DPDPA 2023 s.9 (processing of personal data of children)',
      resources: ['his.guardians'],
    },
  ],
  limitations: [
    'This scan ran against a synthetic demonstration database, not a production system.',
  ],
};

it('renders the summary, prioritised prompts and inventory', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ data: report }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<ScanReportClient tenantId={id(1)} connectorId={id(2)} />);
  expect(await screen.findByText("Possible children's or guardian data")).toBeDefined();
  expect(screen.getByText(/s\.9/)).toBeDefined();
  expect(screen.getByRole('region', { name: 'Personal data inventory' }).textContent).toContain(
    'his.patients',
  );
  expect(screen.getByText(/synthetic demo database/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Download report (HTML)' })).toBeDefined();
  expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('X-Tenant-Id')).toBe(id(1));
});

it('explains how to run a scan when none has completed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code: 'scan_not_run' } }, { status: 404 })),
  );
  render(<ScanReportClient tenantId={id(1)} connectorId={id(2)} />);
  expect(await screen.findByText(/No completed scan yet/)).toBeDefined();
});

it('refuses an unexpected payload instead of rendering it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: { version: 'other' } })),
  );
  render(<ScanReportClient tenantId={id(1)} connectorId={id(2)} />);
  expect(await screen.findByRole('alert')).toBeDefined();
});

it('renders a signed-in website report with rights paths', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: {
          version: 'authenticated-website-report/1',
          organisation: 'Nimbus Stack Technologies (Demo · SaaS)',
          system: 'Customer portal (signed-in, demo)',
          connectorName: 'nimbus customer portal',
          targetBinding: 'sandbox',
          baseUrl: 'http://axiom-portal-nimbus:8080',
          checkedAt: '2026-10-22T11:00:00.000Z',
          summary: {
            pagesRead: 5,
            pagesSkipped: 2,
            personalDataForms: 2,
            personalFields: 5,
            categories: {},
          },
          rights: [
            { key: 'privacyNotice', label: 'Privacy notice', paths: [] },
            { key: 'accessRequest', label: 'Access request', paths: ['/export-data'] },
          ],
          findings: [
            {
              id: 'rights.no_privacy_notice',
              severity: 'high',
              title: 'No privacy notice reachable from the signed-in area',
              detail: 'No privacy link.',
              provision: 'DPDPA 2023 s.5 (notice)',
              resources: ['(signed-in area)'],
            },
          ],
          pages: [
            {
              path: '/billing',
              forms: [
                {
                  fields: [{ name: 'upi_id', categories: ['financial'] }],
                  consentControl: false,
                  purposeText: true,
                },
              ],
            },
          ],
          limitations: ['This scan ran against a synthetic demonstration portal.'],
        },
      }),
    ),
  );
  render(<ScanReportClient tenantId={id(1)} connectorId={id(2)} />);
  expect(
    await screen.findByText('No privacy notice reachable from the signed-in area'),
  ).toBeDefined();
  const rights = screen.getByRole('region', { name: 'Data principal rights paths' });
  expect(rights.textContent).toContain('Not found');
  expect(rights.textContent).toContain('/export-data');
  expect(
    screen.getByRole('region', { name: 'Forms collecting personal data' }).textContent,
  ).toContain('upi_id (financial)');
});
