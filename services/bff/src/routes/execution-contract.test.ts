import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * W5 · R-05 — the BFF half of the execution dispatch contract.
 *
 * The BFF sent camelCase keys to `/internal/execute`, whose Pydantic model
 * requires snake_case and defines no aliases. Every dispatch was a 422. The
 * response was never checked, so the route reported `accepted` for work the
 * runtime had refused — for as long as the endpoint had existed.
 *
 * Neither side's own tests could catch that, because each was internally
 * consistent. Only something spanning both can, so both are pinned to one
 * fixture: this file asserts the BFF produces it, and
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

const { buildExecutionDispatchPayload, EXECUTION_CONTRACT_VERSION } = await import('./v1.js');

const FIXTURE_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'contracts',
  'execution-dispatch.v1.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

describe('execution dispatch payload', () => {
  const built = buildExecutionDispatchPayload({
    tenantId: fixture.tenant_id as string,
    planId: fixture.plan_id as string,
    correlationId: fixture.correlation_id as string,
    actionIds: fixture.action_ids as string[],
    requestKey: fixture.request_key as string,
    mode: fixture.mode as string,
    concurrency: fixture.concurrency as number,
    stopOnFailure: fixture.stop_on_failure as boolean,
    approvalToken: fixture.approval_token,
  });

  it('matches the shared contract fixture exactly', () => {
    expect(built).toEqual(fixture);
  });

  it('is entirely snake_case — the casing mismatch was the whole defect', () => {
    for (const key of Object.keys(built)) {
      expect(key, `${key} is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('carries no key the runtime does not declare', () => {
    // The runtime model sets `extra="forbid"`, so an added key is a 422 rather
    // than a field quietly ignored.
    expect(Object.keys(built).sort()).toEqual(Object.keys(fixture).sort());
  });

  it('states its contract version', () => {
    expect(built.contract_version).toBe(EXECUTION_CONTRACT_VERSION);
    expect(fixture.contract_version).toBe(EXECUTION_CONTRACT_VERSION);
  });

  it('passes the batch request key through, for redelivery handling', () => {
    expect(built.request_key).toBe(fixture.request_key);
  });
});
