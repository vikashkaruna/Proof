-- The scoped writer must still reject an actor without tenant authority.
begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;

insert into auth.users(id,email)
select ('99100300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'w2-authority-'||n||'@example.invalid' from generate_series(1,6) n;
insert into public.users(id,email,is_axiom_internal)
select ('99100300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'w2-authority-'||n||'@example.invalid',n=6 from generate_series(1,6) n;
insert into public.tenants(id,slug,name) values
 ('99100300-0000-4000-8000-000000000010','w2-authority-a','W2 authority A'),
 ('99100300-0000-4000-8000-000000000020','w2-authority-b','W2 authority B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99100300-0000-4000-8000-000000000010','99100300-0000-4000-8000-000000000001','admin'),
 ('99100300-0000-4000-8000-000000000010','99100300-0000-4000-8000-000000000002','viewer'),
 ('99100300-0000-4000-8000-000000000020','99100300-0000-4000-8000-000000000004','admin'),
 ('99100300-0000-4000-8000-000000000010','99100300-0000-4000-8000-000000000005','admin');
-- A revoked membership becomes the same absent-row case as a never-member.
delete from public.tenant_users where tenant_id='99100300-0000-4000-8000-000000000010'
 and user_id='99100300-0000-4000-8000-000000000005';

create function pg_temp.check_actor(actor uuid, allowed boolean, label text)
returns void language plpgsql as $$
declare result jsonb; tenant uuid:='99100300-0000-4000-8000-000000000010';
begin
 result:=public.create_ropa_record(tenant,actor,null,null,'Customer support','consent',
  array['contact'],array['customers'],'{}',false,'{}',12,'Encryption',false,gen_random_uuid());
 perform pg_temp.ok(case when allowed then result->>'status'='active'
  else result->>'error'='forbidden' end,label||' ROPA authority');
 result:=public.create_policy_draft(tenant,actor,'Retention','retention','Retention summary',
  'Reviewable content','{}',gen_random_uuid());
 perform pg_temp.ok(case when allowed then result->>'status'='draft'
  else result->>'error'='forbidden' end,label||' policy authority');
 result:=public.create_playbook_entry(tenant,actor,'Incident review','incident_response',
  'Human review requested','nazar','[{"action":"review"}]'::jsonb,true,gen_random_uuid());
 perform pg_temp.ok(case when allowed then result->>'status'='active'
  else result->>'error'='forbidden' end,label||' playbook authority');
 result:=public.submit_classification_review(tenant,actor,null,'reviewed-system','contact.email',
  'confidential',array['contact'],90,'confirmed',null,'Reviewed classification',gen_random_uuid());
 perform pg_temp.ok(case when allowed then result->>'decision'='confirmed'
  else result->>'error'='forbidden' end,label||' classification authority');
end $$;

set local role human_action_writer;
select pg_temp.check_actor('99100300-0000-4000-8000-000000000003',false,'Never member');
select pg_temp.check_actor('99100300-0000-4000-8000-000000000004',false,'Foreign tenant admin');
select pg_temp.check_actor('99100300-0000-4000-8000-000000000005',false,'Revoked member');
select pg_temp.check_actor('99100300-0000-4000-8000-000000000002',false,'Viewer');
select pg_temp.check_actor(null,false,'Missing actor');
reset role;
-- Rejections must not fabricate any retained records or human ledger events.
select pg_temp.ok((select count(*)=0 from public.ropa_records where tenant_id=
 '99100300-0000-4000-8000-000000000010'),'Rejected ROPA wrote no rows');
select pg_temp.ok((select count(*)=0 from public.policy_drafts where tenant_id=
 '99100300-0000-4000-8000-000000000010'),'Rejected policy wrote no rows');
select pg_temp.ok((select count(*)=0 from public.playbook_entries where tenant_id=
 '99100300-0000-4000-8000-000000000010'),'Rejected playbook wrote no rows');
select pg_temp.ok((select count(*)=0 from public.classification_reviews where tenant_id=
 '99100300-0000-4000-8000-000000000010'),'Rejected classification wrote no rows');
select pg_temp.ok((select count(*)=0 from public.audit_ledger where tenant_id=
 '99100300-0000-4000-8000-000000000010'),'Rejected decisions wrote no ledger events');

set local role human_action_writer;
select pg_temp.check_actor('99100300-0000-4000-8000-000000000001',true,'Tenant admin');
-- Preserve the existing explicit internal-authority exception.
select pg_temp.check_actor('99100300-0000-4000-8000-000000000006',true,'Internal authority');
reset role;
select pg_temp.ok((select count(*)=8 from public.audit_ledger where tenant_id=
 '99100300-0000-4000-8000-000000000010' and action_type::text in
 ('ropa.recorded','policy.drafted','playbook.created','classification.reviewed')),
 'Each authorized operation appends one ledger event');
rollback;
