-- Synthetic policy decisions: only the current human founder records review.
begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message;end if;end $$;
insert into auth.users(id,email) values
 ('99111000-0000-4000-8000-000000000001','policy-founder@example.invalid'),
 ('99111000-0000-4000-8000-000000000002','policy-owner@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('99111000-0000-4000-8000-000000000001','policy-founder@example.invalid',true),
 ('99111000-0000-4000-8000-000000000002','policy-owner@example.invalid',false);
insert into public.tenants(id,slug,name) values
 ('99111000-0000-4000-8000-000000000010','policy-producer-boundary','Synthetic policy boundary');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99111000-0000-4000-8000-000000000010','99111000-0000-4000-8000-000000000001','founder'),
 ('99111000-0000-4000-8000-000000000010','99111000-0000-4000-8000-000000000002','owner');
create temporary table policy_fixture(id uuid,content text,digest text);
grant select,insert on policy_fixture to human_action_writer;
set local role human_action_writer;
insert into policy_fixture select (r->>'draftId')::uuid,'Synthetic retained policy — not published',
 encode(sha256(convert_to('Synthetic retained policy — not published','UTF8')),'hex')
from (select public.create_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000002','Synthetic notice','privacy_notice','Synthetic only',
 'Synthetic retained policy — not published',array[]::text[],'99111000-0000-4000-8000-000000000020') r) q;
reset role;
create function pg_temp.producer(actor public.actor_type,action public.ledger_action_type,phase text)
returns bigint language sql as $$
 select public.append_agent_ledger('99111000-0000-4000-8000-000000000010',gen_random_uuid(),actor,'vibhaag',
 null,null,null,action,'synthetic-policy-decision',null,null,null,null,null,null,'success',
 jsonb_build_object('phase',phase,'decision','approved'));
$$;
create function pg_temp.refuse_review(actor public.actor_type) returns void language plpgsql as $$
begin
 begin perform pg_temp.producer(actor,'policy.reviewed','forged-human-review');
 exception when insufficient_privilege then return;end;
 raise exception 'ASSERTION FAILED: % producer appended policy.reviewed',actor;
end $$;
set local role agent_ledger_writer;
select pg_temp.ok(pg_temp.producer('agent','classification.started','started')>0,'legitimate producer start accepted');
select pg_temp.ok(pg_temp.producer('agent','classification.started','completed')>0,'legitimate producer completion accepted');
reset role;
create temporary table before_refusals as
select c.last_sequence,c.last_entry_hash,(select count(*) from public.audit_ledger where tenant_id=c.tenant_id) as row_count,
 (select last_value from public.audit_ledger_id_seq) as ledger_id
from public.tenant_ledger_counters c where tenant_id='99111000-0000-4000-8000-000000000010';
set local role agent_ledger_writer;
select pg_temp.refuse_review('agent');
select pg_temp.refuse_review('system');
reset role;
select pg_temp.ok((select count(*)=b.row_count from public.audit_ledger where tenant_id='99111000-0000-4000-8000-000000000010'),
 'refused producers append no rows') from before_refusals b;
select pg_temp.ok(c.last_sequence=b.last_sequence and c.last_entry_hash=b.last_entry_hash,
 'refused producers consume no tenant sequence or chain tip')
from public.tenant_ledger_counters c cross join before_refusals b where c.tenant_id='99111000-0000-4000-8000-000000000010';
select pg_temp.ok((select last_value from public.audit_ledger_id_seq)=b.ledger_id,
 'refused producers consume no global ledger identity') from before_refusals b;
set local role human_action_writer;
select pg_temp.ok(public.review_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000002',(select id from policy_fixture),'approved',
 (select digest from policy_fixture),gen_random_uuid())->>'error'='founder_authority_required','owner cannot impersonate founder');
select pg_temp.ok(public.review_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000001',(select id from policy_fixture),'approved',repeat('f',64),
 gen_random_uuid())->>'error'='digest_mismatch','changed content commitment refused');
select pg_temp.ok(public.review_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000001',(select id from policy_fixture),'approved',
 (select digest from policy_fixture),'99111000-0000-4000-8000-000000000021')->>'status'='approved','real founder approval remains accepted');
select pg_temp.ok(public.review_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000001',(select id from policy_fixture),'approved',
 (select digest from policy_fixture),gen_random_uuid())->>'error'='invalid_draft_state','terminal review cannot be replaced');
reset role;
select pg_temp.ok((select count(*)=1 from public.policy_drafts d join policy_fixture f on d.id=f.id
 where d.status='approved' and d.reviewed_by='99111000-0000-4000-8000-000000000001'
 and d.content=f.content and d.content_sha256=f.digest),'approved policy retains exact bytes, digest and human reviewer');
select pg_temp.ok((select count(*)=1 from public.audit_ledger l join policy_fixture f on f.id::text=l.target_ref
 where l.tenant_id='99111000-0000-4000-8000-000000000010' and l.action_type='policy.reviewed'
 and l.actor_type='human' and l.actor_id='99111000-0000-4000-8000-000000000001'
 and l.correlation_id='99111000-0000-4000-8000-000000000021' and l.result='success'
 and l.detail->>'decision'='approved' and l.detail->>'content_hash'=f.digest),'exactly one linked human policy decision');
-- Rejection is also a human decision, retaining the existing deprecated state.
truncate policy_fixture;
set local role human_action_writer;
insert into policy_fixture select (r->>'draftId')::uuid,'Synthetic rejected policy',
 encode(sha256(convert_to('Synthetic rejected policy','UTF8')),'hex')
from (select public.create_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000002','Synthetic retention','retention','Synthetic only',
 'Synthetic rejected policy',array[]::text[],'99111000-0000-4000-8000-000000000022') r) q;
select pg_temp.ok(public.review_policy_draft('99111000-0000-4000-8000-000000000010',
 '99111000-0000-4000-8000-000000000001',(select id from policy_fixture),'rejected',
 (select digest from policy_fixture),'99111000-0000-4000-8000-000000000023')->>'status'='deprecated','real founder rejection remains accepted');
reset role;
select pg_temp.ok((select count(*)=1 from public.audit_ledger l join policy_fixture f on f.id::text=l.target_ref
 where l.tenant_id='99111000-0000-4000-8000-000000000010' and l.action_type='policy.reviewed'
 and l.actor_type='human' and l.actor_id='99111000-0000-4000-8000-000000000001'
 and l.correlation_id='99111000-0000-4000-8000-000000000023' and l.detail->>'decision'='rejected'
 and l.detail->>'status'='deprecated' and l.detail->>'content_hash'=f.digest),'rejection retains exact human receipt');
select pg_temp.ok((select count(*)=2 from public.audit_ledger where tenant_id='99111000-0000-4000-8000-000000000010'
 and action_type='classification.started' and actor_type='agent' and detail->>'phase' in ('started','completed')),
 'both valid producer phases remain');
select pg_temp.ok((select count(*)=6 from public.audit_ledger where tenant_id='99111000-0000-4000-8000-000000000010'),
 'only sanctioned starts, drafts and human decisions persist');
select pg_temp.ok((select last_sequence=6 from public.tenant_ledger_counters where tenant_id='99111000-0000-4000-8000-000000000010'),
 'tenant sequence has no refused producer gaps');
select pg_temp.ok(not exists(select 1 from public.verify_ledger('99111000-0000-4000-8000-000000000010',1)),
 'ledger chain remains intact');
rollback;
