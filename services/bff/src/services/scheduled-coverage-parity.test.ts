import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const root = new URL('../../../../', import.meta.url);
const read = (name: string) =>
  readFileSync(new URL('infra/supabase/migrations/' + name, root), 'utf8');
const next = read('0175_scheduled_coverage_reassessment.sql');
function body(text: string, name: string) {
  const start = text.search(
    new RegExp('create(?: or replace)? function ' + name.replaceAll('.', '\\.') + '\\('),
  );
  if (start < 0) throw Error('Reviewed function missing');
  const a = text.indexOf('as $$', start) + 5;
  if (a < 5) throw Error('Reviewed body missing');
  return text.slice(a, text.indexOf('$$;', a));
}
it('leaves original interactive task delegation and dispatch bodies untouched', () => {
  const delegate = body(
    read('0041_workload_task_delegations.sql'),
    'public.delegate_workload_task',
  );
  const expected = delegate
    .replace(
      'begin\n',
      'begin\n perform controller_security.coverage175_task_binding(p_fire_id,p_tenant_id,p_actor_id,p_workload_id,p_agent,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_scopes,p_expires_at);\n',
    )
    .replace(
      "perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,",
      "perform public.append_ledger(p_tenant_id,p_correlation_id,'agent','scheduled-coverage-coordinator',",
    );
  expect(body(next, 'controller_security.coverage175_delegate')).toBe(expected);
  const core = body(
    read('0044_assessment_dispatch_outbox.sql'),
    'public.enqueue_assessment_dispatch',
  );
  const extended = core
    .replace(
      'begin\n',
      "begin\n perform controller_security.coverage175_task_binding(p_fire_id,p_tenant_id,p_actor_id,p_workload_id,'parikshan',p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,array['control_library.read','findings.write'],p_expires_at);\n",
    )
    .replace(
      'delegated:=public.delegate_workload_task(',
      'delegated:=controller_security.coverage175_delegate(',
    )
    .replace(
      "p_correlation_id,p_input_hash,p_proof_hash,array['control_library.read','findings.write'],p_expires_at);",
      "p_correlation_id,p_input_hash,p_proof_hash,array['control_library.read','findings.write'],p_expires_at,p_fire_id);",
    );
  expect(body(next, 'controller_security.coverage175_enqueue_core')).toBe(extended);
  for (const source of [delegate, core])
    expect(next).toContain(createHash('sha256').update(source).digest('hex'));
});
it('preserves all previous tenant-scoped public wrapper behavior with one narrow pre-lock guard', () => {
  const base = read('0049_controller_backend_scope.sql');
  for (const name of [
    'start_workload_assessment',
    'complete_workload_assessment',
    'confirm_workload_assessment',
  ]) {
    const before = body(base, 'public.' + name);
    const extra = `\n perform controller_security.coverage175_before_tool(p_tenant_id,p_run_id,${name === 'confirm_workload_assessment' ? 'true' : 'false'});`;
    expect(body(next, 'public.' + name).replace(extra, '')).toBe(before);
    expect(next).toContain(createHash('sha256').update(before).digest('hex'));
  }
  const before = body(
    read('0147_local_public_control_assessment_dispatch.sql'),
    'public.claim_local_assessment_dispatch',
  );
  const current = body(next, 'public.claim_local_assessment_dispatch');
  expect(
    current.replace(
      '\n perform controller_security.coverage175_before_claim(p_tenant_id,p_job_id);',
      '',
    ),
  ).toBe(before);
  expect(current.indexOf('coverage175_before_claim')).toBeLessThan(
    current.indexOf('pg_advisory_xact_lock_shared'),
  );
});
it('retains every original local custody check, adding only a source-bound agent-attribution alternative', () => {
  const before = body(
    read('0143_local_custody_admission.sql'),
    'controller_security.local143_grant_binding',
  );
  const changed = body(next, 'controller_security.local143_grant_binding');
  expect(
    changed.replace(
      "((l.actor_id is distinct from j.actor_id::text or l.actor_type::text is distinct from 'human') and not coalesce(controller_security.coverage175_request_actor(j,l),false))",
      "l.actor_id is distinct from j.actor_id::text or l.actor_type::text is distinct from 'human'",
    ),
  ).toBe(before);
  expect(body(next, 'controller_security.coverage175_request_actor')).toContain(
    'fire.requested_receipt',
  );
});
it('keeps private helpers inheriting scan bounds and never grants generic kernels to a transport role', () => {
  for (const name of ['coverage175_source', 'coverage175_live', 'coverage175_fire_live']) {
    const start = next.indexOf('create function controller_security.' + name + '(');
    expect(next.slice(start, next.indexOf('as $$', start))).not.toContain('lock_timeout');
  }
  const grants = next
    .split('\n')
    .filter((s) => s.startsWith('grant '))
    .join('\n');
  expect(grants).not.toContain('controller_security.');
  expect(grants).not.toContain(' to authenticated');
  expect(grants).not.toContain(' to public');
  expect(next).not.toMatch(/create role|grant .* to authenticator|create extension/i);
});
