import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * W5 · M3.2 — the BFF half of the dry-run dispatch contract.
 *
 * Pinned to one fixture from both sides, exactly like the execution
 * dispatch contract: this file asserts the BFF produces the payload, and
 * `services/agent-runtime/tests/test_dry_run.py` asserts the runtime's
 * Pydantic model accepts it. Change either side alone and the other fails.
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

const { buildDryRunDispatchPayload, DRY_RUN_CONTRACT_VERSION } = await import('./v1.js');

const FIXTURE_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'contracts',
  'dry-run.v1.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

describe('dry-run dispatch payload', () => {
  const built = buildDryRunDispatchPayload({
    tenantId: fixture.tenant_id as string,
    actionId: fixture.action_id as string,
    actionType: fixture.action_type as string,
    parameters: fixture.parameters as Record<string, unknown>,
    blastRadius: fixture.blast_radius as Record<string, unknown>,
    rollbackDefinition: fixture.rollback_definition as Record<string, unknown>,
    correlationId: fixture.correlation_id as string,
  });

  it('matches the shared contract fixture exactly', () => {
    expect(built).toEqual(fixture);
  });

  it('is entirely snake_case — the execution dispatch defect must not repeat here', () => {
    for (const key of Object.keys(built)) {
      expect(key, `${key} is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('carries no key the runtime does not declare', () => {
    // The runtime model sets `extra="forbid"`, so an added key is a 422.
    expect(Object.keys(built).sort()).toEqual(Object.keys(fixture).sort());
  });

  it('states its contract version', () => {
    expect(built.contract_version).toBe(DRY_RUN_CONTRACT_VERSION);
    expect(fixture.contract_version).toBe(DRY_RUN_CONTRACT_VERSION);
  });
});
