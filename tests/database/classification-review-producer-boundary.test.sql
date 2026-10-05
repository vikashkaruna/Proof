-- A producer may report its work, but cannot record a person's classification decision.
begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if;
end $$;

insert into auth.users(id,email) values
 ('99100800-0000-4000-8000-000000000001','classification-owner@example.invalid');
insert into public.users(id,email) values
 ('99100800-0000-4000-8000-000000000001','classification-owner@example.invalid');
insert into public.tenants(id,slug,name) values
 ('99100800-0000-4000-8000-000000000010','classification-producer-boundary','Review boundary');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99100800-0000-4000-8000-000000000010','99100800-0000-4000-8000-000000000001','owner');

create function pg_temp.producer(actor public.actor_type, action public.ledger_action_type, phase text)
returns bigint language sql as $$
  select public.append_agent_ledger(
    '99100800-0000-4000-8000-000000000010',gen_random_uuid(),actor,'vibhaag',
    null,null,null,action,'retained-classification',null,null,null,null,null,null,
    'success',jsonb_build_object('phase',phase));
$$;
create function pg_temp.refuse_review(actor public.actor_type) returns void language plpgsql as $$
begin
  begin
    perform pg_temp.producer(actor,'classification.reviewed','forged-human-review');
  exception when insufficient_privilege then return;
  end;
  raise exception 'ASSERTION FAILED: % producer appended classification.reviewed',actor;
end $$;

-- Both legitimate agent lifecycle phases remain appendable through the same role.
set local role agent_ledger_writer;
select pg_temp.ok(pg_temp.producer('agent','classification.started','started')>0,
  'legitimate agent start accepted');
select pg_temp.ok(pg_temp.producer('agent','classification.started','completed')>0,
  'legitimate agent completion accepted');
reset role;

create temp table before_refusals as
select c.last_sequence,c.last_entry_hash,
  (select count(*) from public.audit_ledger where tenant_id=c.tenant_id) as row_count,
  (select last_value from public.audit_ledger_id_seq) as ledger_id
from public.tenant_ledger_counters c
where tenant_id='99100800-0000-4000-8000-000000000010';

-- The real producer DB role cannot relabel a human decision as either actor type.
set local role agent_ledger_writer;
select pg_temp.refuse_review('agent');
select pg_temp.refuse_review('system');
reset role;

select pg_temp.ok((select count(*)=b.row_count from public.audit_ledger
  where tenant_id='99100800-0000-4000-8000-000000000010'),
  'refused producers append no rows') from before_refusals b;
select pg_temp.ok(c.last_sequence=b.last_sequence and c.last_entry_hash=b.last_entry_hash,
  'refused producers consume no tenant sequence or chain tip')
from public.tenant_ledger_counters c cross join before_refusals b
where c.tenant_id='99100800-0000-4000-8000-000000000010';
select pg_temp.ok((select last_value from public.audit_ledger_id_seq)=b.ledger_id,
  'refused producers consume no global ledger identity') from before_refusals b;

-- Keep the real existing human RPC, its actor and adjusted declaration working.
set local role human_action_writer;
select pg_temp.ok(public.submit_classification_review(
  '99100800-0000-4000-8000-000000000010','99100800-0000-4000-8000-000000000001',
  null,'human-declared-system','manual-declaration.contact','public',array['contact'],
  0,'adjusted','internal','Human declaration only; no source scan was performed.',
  '99100800-0000-4000-8000-000000000020')->>'decision'='adjusted',
  'legitimate human classification review accepted');
reset role;

select pg_temp.ok((select count(*)=1 from public.classification_reviews
  where tenant_id='99100800-0000-4000-8000-000000000010'
    and reviewed_by='99100800-0000-4000-8000-000000000001'
    and system_id='human-declared-system' and decision='adjusted'
    and sensitivity_level='public' and adjusted_sensitivity='internal' and confidence_score=0),
  'human declaration retains exact actor and values');
select pg_temp.ok((select count(*)=1 from public.audit_ledger l
  join public.classification_reviews r on r.tenant_id=l.tenant_id and r.id::text=l.target_ref
  where l.tenant_id='99100800-0000-4000-8000-000000000010'
    and l.action_type='classification.reviewed' and l.actor_type='human'
    and l.actor_id='99100800-0000-4000-8000-000000000001'
    and l.correlation_id='99100800-0000-4000-8000-000000000020'
    and l.result='success' and l.detail->>'decision'='adjusted'
    and l.detail->>'final_sensitivity'='internal'),
  'exactly one human review receipt is linked to its record');
select pg_temp.ok((select count(*)=2 from public.audit_ledger
  where tenant_id='99100800-0000-4000-8000-000000000010'
    and action_type='classification.started' and actor_type='agent' and actor_id='vibhaag'
    and detail->>'phase' in ('started','completed')),
  'both agent lifecycle phases persist');
select pg_temp.ok((select count(*)=3 from public.audit_ledger
  where tenant_id='99100800-0000-4000-8000-000000000010'),
  'only sanctioned start, completion and human decision persist');
select pg_temp.ok((select last_sequence=3 from public.tenant_ledger_counters
  where tenant_id='99100800-0000-4000-8000-000000000010'),
  'tenant sequence contains no producer review gaps');
select pg_temp.ok(not exists(select 1 from public.verify_ledger(
  '99100800-0000-4000-8000-000000000010',1)), 'ledger chain remains intact');
rollback;
