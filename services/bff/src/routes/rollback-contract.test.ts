import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * W5 · M3.5 — the BFF half of the manual rollback dispatch contract.
 *
 * The undo is an estate write like execution, so it dispatches over a
 * versioned snake_case contract whose both halves are pinned to one fixture:
 * this file asserts the BFF produces it, and
 * `services/agent-runtime/tests/test_execution_contract.py` asserts the
 * runtime accepts it. Change either side alone and the other fails.
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

const { buildRollbackDispatchPayload, ROLLBACK_CONTRACT_VERSION } = await import('./v1.js');

const FIXTURE_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'contracts',
  'rollback-dispatch.v1.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

describe('manual rollback dispatch payload', () => {
  const built = buildRollbackDispatchPayload({
    tenantId: fixture.tenant_id as string,
    batchId: fixture.batch_id as string,
    actionIds: fixture.action_ids as string[],
    correlationId: fixture.correlation_id as string,
  });

  it('matches the shared contract fixture exactly', () => {
    expect(built).toEqual(fixture);
  });

  it('is entirely snake_case', () => {
    for (const key of Object.keys(built)) {
      expect(key, `${key} is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('carries no key the runtime does not declare', () => {
    // The runtime model sets `extra="forbid"`, so an added key is a 422
    // rather than a field quietly ignored.
    expect(Object.keys(built).sort()).toEqual(Object.keys(fixture).sort());
  });

  it('states its contract version', () => {
    expect(built.contract_version).toBe(ROLLBACK_CONTRACT_VERSION);
    expect(fixture.contract_version).toBe(ROLLBACK_CONTRACT_VERSION);
    expect(fixture.contract_version).toBe(1);
  });

  it('scopes the undo to one execution and its correlation id', () => {
    expect(built.batch_id).toBe(fixture.batch_id);
    expect(built.correlation_id).toBe(fixture.correlation_id);
    expect(Array.isArray(built.action_ids)).toBe(true);
    expect((built.action_ids as string[]).length).toBeGreaterThan(0);
  });
});
