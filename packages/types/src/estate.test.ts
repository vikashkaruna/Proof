import { describe, expect, it } from 'vitest';
import {
  EstateScanSchema,
  CreateEstateRequestSchema,
  CreateEstateSystemRequestSchema,
} from './estate';
const scan = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  estateId: '00000000-0000-4000-8000-000000000003',
  createdAt: '2026-09-21T00:00:00Z',
  summary: {},
};
describe('scan lifecycle contract', () => {
  it('does not call a queued scan successful without a completed interval', () => {
    expect(
      EstateScanSchema.safeParse({ ...scan, status: 'queued', startedAt: null, completedAt: null })
        .success,
    ).toBe(true);
    expect(
      EstateScanSchema.safeParse({
        ...scan,
        status: 'succeeded',
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(false);
  });
  it('allows cancellation before starting but rejects reversed intervals', () => {
    expect(
      EstateScanSchema.safeParse({
        ...scan,
        status: 'cancelled',
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(true);
    expect(
      EstateScanSchema.safeParse({
        ...scan,
        status: 'succeeded',
        startedAt: '2026-09-21T01:00:00Z',
        completedAt: '2026-09-21T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('estate field limits', () => {
  it('accepts one hundred full-length unique category keys', () => {
    const dataCategories = Array.from({ length: 100 }, (_, i) => `category-${i}`.padEnd(80, 'a'));
    expect(
      CreateEstateSystemRequestSchema.safeParse({
        name: 'Payroll',
        systemKind: 'database',
        dataCategories,
      }).success,
    ).toBe(true);
    expect(dataCategories.join(', ')).toHaveLength(8198);
  });

  it.each([
    { name: '   ', slug: 'estate' },
    { name: 'a'.repeat(201), slug: 'estate' },
    { name: 'Estate', slug: 'a'.repeat(81) },
    { name: 'Estate', slug: 'Upper-case' },
    { name: 'Estate', slug: 'repeated--hyphens' },
    { name: 'Estate', slug: 'trailing-' },
    { name: 'Estate', slug: 'estate', description: 'a'.repeat(4001) },
  ])('refuses invalid estate fields %#', (payload) => {
    expect(CreateEstateRequestSchema.safeParse(payload).success).toBe(false);
  });
  it('allows the documented field limits and optional empty description', () => {
    expect(CreateEstateRequestSchema.parse({ name: ' a ', slug: 'estate' })).toEqual({
      name: 'a',
      slug: 'estate',
      description: '',
    });
    expect(
      CreateEstateRequestSchema.safeParse({
        name: 'a'.repeat(200),
        slug: 'a'.repeat(80),
        description: 'a'.repeat(4000),
      }).success,
    ).toBe(true);
  });
  it.each([
    { name: '   ' },
    { systemKind: 'postgres' },
    { externalRef: 'a'.repeat(501) },
    { dataCategories: ['identity', 'identity'] },
    { dataCategories: ['Health Data'] },
    { dataCategories: Array.from({ length: 101 }, (_, i) => `category-${i}`) },
  ])('refuses invalid system fields %#', (change) => {
    expect(
      CreateEstateSystemRequestSchema.safeParse({
        name: 'Payroll',
        systemKind: 'database',
        ...change,
      }).success,
    ).toBe(false);
  });
});
