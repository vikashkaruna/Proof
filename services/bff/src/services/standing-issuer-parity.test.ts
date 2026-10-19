import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const old = readFileSync(
  new URL(
    '../../../../infra/supabase/migrations/0026_atomic_approval_issuance.sql',
    import.meta.url,
  ),
  'utf8',
);
const next = readFileSync(
  new URL(
    '../../../../infra/supabase/migrations/0173_standing_approval_coordinator.sql',
    import.meta.url,
  ),
  'utf8',
);
function body(source: string, name: string) {
  const start = source.indexOf(`create function ${name}(`);
  if (start < 0) throw Error('Expected exact reviewed function');
  const open = source.indexOf('as $$', start) + 5;
  return source.slice(open, source.indexOf('$$;', open));
}
it('preserves every byte of the interactive atomic issuer body apart from the fixed private guard and actor branch', () => {
  const original = body(old, 'public.issue_plan_approval');
  let extended = body(next, 'controller_security.issue_plan_approval173');
  const guard = `  if p_coordinator_fire_id is not null then\n    perform controller_security.standing173_assert_issuance(p_coordinator_fire_id,p_tenant_id,p_plan_id,p_action_ids,p_approver_id,p_mode,p_concurrency,p_stop_on_failure,p_signed_payload,p_nonce,p_expires_at,p_expected_digest,p_conditions,p_mfa_detail,p_correlation_id);\n  end if;\n`;
  expect(extended.split(guard)).toHaveLength(2);
  extended = extended
    .replace(guard, '')
    .replace(
      `case when p_coordinator_fire_id is null then 'human'::public.actor_type else 'agent'::public.actor_type end,\n    case when p_coordinator_fire_id is null then p_approver_id::text else 'standing-policy-coordinator' end,`,
      `'human', p_approver_id::text,`,
    );
  expect(extended).toBe(original);
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    '194cc18bf8ee2f21c2f3816b7254656db7534ebdc4f17d4d5377930701feb2cd',
  );
});
it('interactive wrapper fixes the new coordinator capability to null', () => {
  const wrapper = body(next, 'public.issue_plan_approval');
  expect(wrapper).toContain('p_correlation_id,null);');
  expect(wrapper).not.toContain('p_coordinator_fire_id');
});

it('pins and retains the legacy base-policy revoke body without rewriting its return or actor', () => {
  const source = readFileSync(
    new URL(
      '../../../../infra/supabase/migrations/0068_standing_policy_engine.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const original = body(source, 'public.revoke_standing_policy');
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    '242b2d01bd24632e800cb80c82f4cb862de2d4e6ef28a27514626be93c1b7849',
  );
  expect(next).toContain(
    'alter function controller_security.revoke_standing_policy(uuid,uuid,uuid,uuid)rename to revoke_standing_policy_before173;',
  );
  const wrapper = body(next, 'public.revoke_standing_policy');
  expect(wrapper).toContain(
    'result:=controller_security.revoke_standing_policy_before173(p_tenant_id,p_policy_id,p_revoked_by,p_correlation_id);',
  );
  expect(wrapper.indexOf('pg_advisory_xact_lock')).toBeLessThan(
    wrapper.indexOf('order by p.id for update'),
  );
  expect(wrapper.indexOf('order by p.id for update')).toBeLessThan(
    wrapper.indexOf('result:=controller_security.revoke_standing_policy_before173'),
  );
  expect(wrapper).toContain("tok.status='issued'");
  expect(wrapper).toContain("w.state='issued'");
  expect(wrapper).toContain('return result;');
});
