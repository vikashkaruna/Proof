-- Synthetic human workflow records; transactional and never production data.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$
 select ('99111100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'operator-workflow-'||n||'@example.invalid' from generate_series(1,5)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'operator-workflow-'||n||'@example.invalid',n in (2,4) from generate_series(1,5)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'operator-workflows-a','A'),(pg_temp.id(12),'operator-workflows-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 (pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'founder'),
 (pg_temp.id(11),pg_temp.id(3),'viewer'),(pg_temp.id(11),pg_temp.id(4),'axiom_analyst'),
 (pg_temp.id(12),pg_temp.id(5),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('operator-workflow-test',now(),'test','Synthetic only',0);
insert into public.engagements(id,tenant_id,library_version,title) values
 (pg_temp.id(31),pg_temp.id(11),'operator-workflow-test','A'),(pg_temp.id(32),pg_temp.id(12),'operator-workflow-test','B');
create function pg_temp.ropa() returns jsonb language sql as $$ select jsonb_build_object(
 'engagementId',pg_temp.id(31),'sourceNote','Operator interview; private facts unresolved','system','Public contact form',
 'purpose',null,'legalBasis',null,'retentionMonths',null,'dataCategories',null,'processors',null,
 'region',null,'crossBorder',null,'securityMeasures',null,'dataPrincipals',null,'recipients',null,
 'destinationCountries',null,'transferSafeguards',null,'dpiaRequired',null) $$;
create function pg_temp.task(cost integer default 15,reps integer default 3) returns jsonb language sql as $$
 select jsonb_build_object('engagementId',pg_temp.id(31),'taskName','Review inventory','source','Measured engagement',
 'durationMinutes',cost,'repetitions',reps,'notes','Synthetic observed time') $$;
create function pg_temp.policy(ropa uuid default null,category text default 'consent_notice') returns jsonb language sql as $$
 select jsonb_build_object('engagementId',pg_temp.id(31),'sourceNote','Human draft with unresolved legal facts','title','Synthetic policy',
 'category',category,'content','Synthetic draft — legal review required. No publication.', 'sourceRopaId',ropa) $$;
create function pg_temp.record(kind text,payload jsonb,op integer,a integer default 1,t integer default 11) returns jsonb language sql as $$
 select public.record_operator_workflow(pg_temp.id(t),pg_temp.id(a),pg_temp.id(op),kind,payload,gen_random_uuid()) $$;
create temporary table workflow_fixture(k text primary key,r jsonb);
grant select,insert,update on workflow_fixture to human_action_writer;
select pg_temp.ok(not public.operator_workflow_valid('delivery_task',pg_temp.task()||'{"durationMinutes":1.5}'),
 'delivery validator rejects fractional observed minutes before storage casting');
set local role human_action_writer;
insert into workflow_fixture values('ropa',pg_temp.record('ropa',pg_temp.ropa(),101));
select pg_temp.ok((select r->>'replayed'='false' and r->'data'->>'kind'='ropa' and r->'data'->'payload'=pg_temp.ropa() from workflow_fixture where k='ropa'),'nullable unknowns retained exactly');
select pg_temp.ok((select r->'data'->>'receipt_id' ~ '^[1-9][0-9]*$' and r->'data'->'content_sha256'='null'::jsonb from workflow_fixture where k='ropa'),'human RoPA receipt without legal attestation digest');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),101)->>'replayed'='true','exact replay retained once');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"purpose":"Different"}',101)->>'error'='idempotency_conflict','changed payload refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),101,2)->>'error'='idempotency_conflict','other actor cannot steal operation');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),102,3)->>'error'='forbidden','viewer cannot create');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),103,4)->>'error'='forbidden','analyst lacks estate management');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),104,5)->>'error'='forbidden','absent tenant membership refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||jsonb_build_object('engagementId',pg_temp.id(32)),105)->>'error'='context_refused','foreign engagement refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"source":{"observationId":"99111100-0000-4000-8000-000000000999","outputSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}',106)->>'error'='source_refused','unretained observation refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"region":"   "}',107)->>'error'='invalid_record','blank strings do not replace unknown');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"retentionMonths":false}',108)->>'error'='invalid_record','boolean retention refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"dataCategories":"contact"}',109)->>'error'='invalid_record','string category list refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"dpiaRequired":"false"}',110)->>'error'='invalid_record','string boolean refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()-'legalBasis',111)->>'error'='invalid_record','omitted unknown key refused');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()-'crossBorder',113)->>'error'='invalid_record','omitted nullable boolean is not an explicit unknown');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa()||'{"actorId":"forged"}',112)->>'error'='invalid_record','forged payload authority refused');
insert into workflow_fixture values('task',pg_temp.record('delivery_task',pg_temp.task(),121)),('task2',pg_temp.record('delivery_task',pg_temp.task(5,20),122));
select pg_temp.ok((select r->'data'->'payload'->>'durationMinutes'='15' from workflow_fixture where k='task'),'observed time captured');
select pg_temp.ok(pg_temp.record('delivery_task',pg_temp.task()||'{"repetitions":0}',123)->>'error'='invalid_record','zero frequency refused');
select pg_temp.ok(pg_temp.record('delivery_task',pg_temp.task()||'{"durationMinutes":1.5}',124)->>'error'='invalid_record','fractional minutes refused');
select pg_temp.ok(pg_temp.record('delivery_task',pg_temp.task()||'{"durationMinutes":"12"}',125)->>'error'='invalid_record','string minutes refused');
select pg_temp.ok((public.list_operator_workflows(pg_temp.id(11),pg_temp.id(3),'delivery_task',1,0)->'data'->0->>'id')=
 (select r->'data'->>'id' from workflow_fixture where k='task2'),'delivery backlog ranked frequency times cost');
select pg_temp.ok(public.list_operator_workflows(pg_temp.id(11),pg_temp.id(3),'delivery_task',1,0)->'meta'->>'hasMore'='true','bounded page reports remaining task');
select pg_temp.ok(public.list_operator_workflows(pg_temp.id(11),pg_temp.id(3),'delivery_task',1,1)->'meta'->>'hasMore'='false','last page completes rank');
select pg_temp.ok(public.list_operator_workflows(pg_temp.id(11),pg_temp.id(3),'ropa',51,0)->>'error'='invalid_record','oversized page refused');
select pg_temp.ok(public.list_operator_workflows(pg_temp.id(12),pg_temp.id(3),'ropa',20,0)->>'error'='forbidden','foreign list refused');
insert into workflow_fixture values('policy',pg_temp.record('policy_draft',pg_temp.policy((select (r->'data'->>'id')::uuid from workflow_fixture where k='ropa')),131));
select pg_temp.ok((select r->'data'->>'kind'='policy_draft' and r->'data'->>'content_sha256'=encode(sha256(convert_to(pg_temp.policy()->>'content','UTF8')),'hex') from workflow_fixture where k='policy'),'policy preserves exact UTF8 commitment');
select pg_temp.ok(pg_temp.record('policy_draft',pg_temp.policy(null,'dpa_template'),132)->'data'->'payload'->>'category'='dpa_template','DPA template accepted as unpublished draft');
select pg_temp.ok(pg_temp.record('policy_draft',pg_temp.policy(pg_temp.id(998)),133)->>'error'='source_refused','nonexistent source RoPA refused');
insert into workflow_fixture values('review_payload',jsonb_build_object('draftId',(select r->'data'->>'id' from workflow_fixture where k='policy'),
 'expectedHash',(select r->'data'->>'content_sha256' from workflow_fixture where k='policy'),'decision','approved','reason','Reviewed exact draft; publication remains separate'));
select pg_temp.ok(pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload'),141)->>'error'='founder_authority_required','owner cannot review');
select pg_temp.ok(pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload')||jsonb_build_object('expectedHash',repeat('f',64)),142,2)->>'error'='digest_mismatch','changed policy digest refused');
select pg_temp.ok(pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload')||'{"reason":" "}',143,2)->>'error'='invalid_record','review reason required');
select pg_temp.ok(public.review_policy_draft(pg_temp.id(11),pg_temp.id(2),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='policy'),null,
 (select r->'data'->>'content_sha256' from workflow_fixture where k='policy'),gen_random_uuid(),'Required review reason')->>'error'='invalid_request',
 'direct reason-bound review refuses null decision');
insert into workflow_fixture values('review',pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload'),144,2));
select pg_temp.ok((select r->'data'->>'kind'='policy_review' and r->'data'->'payload'->>'reason'='Reviewed exact draft; publication remains separate' from workflow_fixture where k='review'),'founder exact decision reason retained');
select pg_temp.ok(pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload'),144,2)->>'replayed'='true','founder exact decision replay idempotent');
select pg_temp.ok(pg_temp.record('policy_review',(select r from workflow_fixture where k='review_payload'),145,2)->>'error'='invalid_draft_state','terminal draft cannot get second review');
select pg_temp.ok(public.reconcile_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101))->'data'->>'id'=(select r->'data'->>'id' from workflow_fixture where k='ropa'),'actor recovery retains exact operation');
select pg_temp.ok(public.reconcile_operator_workflow(pg_temp.id(11),pg_temp.id(2),pg_temp.id(101))->'data'='null'::jsonb,'actor cannot recover another operation');
select pg_temp.ok(public.read_operator_workflow(pg_temp.id(11),pg_temp.id(3),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='ropa'))->'data'->'payload'=pg_temp.ropa(),
 'current reader loads exact saved RoPA for policy generation');
select pg_temp.ok(public.read_operator_workflow(pg_temp.id(12),pg_temp.id(5),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='ropa'))->>'error'='record_not_found',
 'foreign tenant cannot resolve saved RoPA');
select pg_temp.ok(public.read_operator_policy_review(pg_temp.id(11),pg_temp.id(3),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='policy'))->'data'->0->'payload'=(select r from workflow_fixture where k='review_payload'),
 'per-draft history retains its exact reason regardless of global pagination');
select pg_temp.ok(public.read_operator_policy_review(pg_temp.id(11),pg_temp.id(3),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='ropa'))->>'error'='draft_not_found',
 'non-draft cannot acquire policy history');
select pg_temp.ok(public.read_operator_policy_review(pg_temp.id(12),pg_temp.id(5),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='policy'))->>'error'='draft_not_found',
 'foreign per-draft history cannot resolve source');
reset role;
-- Trusted fixture corruption exercises the read verifier without rewriting
-- immutable workflow records or any audit receipt. Restore before proceeding.
update public.policy_drafts set reviewed_by=pg_temp.id(1)
 where id=(select (r->'data'->>'id')::uuid from workflow_fixture where k='policy');
set local role human_action_writer;
select pg_temp.ok(public.read_operator_policy_review(pg_temp.id(11),pg_temp.id(3),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='policy'))->>'error'='invalid_draft_state',
 'history refuses reviewer identity inconsistent with recorded human receipt');
reset role;
update public.policy_drafts set reviewed_by=pg_temp.id(2)
 where id=(select (r->'data'->>'id')::uuid from workflow_fixture where k='policy');
set local role human_action_writer;
-- Existing legacy review remains compatible, but cannot masquerade as missing
-- new-format founder review when its terminal decision has no reason row.
insert into workflow_fixture values('legacy_policy',pg_temp.record('policy_draft',pg_temp.policy(),134));
select pg_temp.ok(public.read_operator_policy_review(pg_temp.id(11),pg_temp.id(3),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='legacy_policy'))->'data'='[]'::jsonb,
 'unreviewed wrapper draft has an explicitly empty per-draft history');
select pg_temp.ok(public.review_policy_draft(pg_temp.id(11),pg_temp.id(2),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='legacy_policy'),'approved',
 (select r->'data'->>'content_sha256' from workflow_fixture where k='legacy_policy'),gen_random_uuid())->>'status'='approved',
 'legacy review compatibility retained');
select pg_temp.ok(public.read_operator_policy_review(pg_temp.id(11),pg_temp.id(3),
 (select (r->'data'->>'id')::uuid from workflow_fixture where k='legacy_policy'))->>'error'='legacy_review_history_unavailable',
 'legacy terminal review does not display as missing decision');
reset role;
select pg_temp.ok((select count(*)=7 from public.operator_workflow_records where tenant_id=pg_temp.id(11)),'only valid records retained');
select pg_temp.ok((select count(*)=8 from public.audit_ledger where tenant_id=pg_temp.id(11)),'one human receipt per record plus explicitly legacy review; no refused or replay receipt');
select pg_temp.ok((select count(*)=0 from public.policy_drafts where tenant_id=pg_temp.id(11) and status='published'),'review approval never publishes');
select pg_temp.ok((select count(*)=1 from public.audit_ledger l join workflow_fixture f on l.id=(f.r->'data'->>'receipt_id')::bigint
 where f.k='review' and l.actor_type='human' and l.actor_id=pg_temp.id(2)::text and l.action_type='policy.reviewed'
 and l.detail->>'reason'='Reviewed exact draft; publication remains separate'),'review receipt contains real human and reason');
create function pg_temp.immutable() returns void language plpgsql as $$
begin
 begin update public.operator_workflow_records set payload='{}' where tenant_id=pg_temp.id(11);
 exception when others then return;end;
 raise exception 'ASSERTION: immutable workflow changed';
end $$;
select pg_temp.immutable();
select pg_temp.ok(not has_table_privilege('service_role','public.operator_workflow_records','INSERT') and
 not has_table_privilege('human_action_writer','public.operator_workflow_records','INSERT'),'no direct record insertion authority');
select pg_temp.ok(not has_function_privilege('service_role','public.record_operator_workflow(uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE') and
 not has_function_privilege('agent_ledger_writer','public.record_operator_workflow(uuid,uuid,uuid,text,jsonb,uuid)','EXECUTE'),'service and producer cannot impersonate operator writes');
create function pg_temp.producer_refused(action public.ledger_action_type) returns void language plpgsql as $$
begin
 begin
  perform public.append_agent_ledger(pg_temp.id(11),gen_random_uuid(),'agent','vibhaag',null,null,null,
   action,'synthetic-operator-workflow',null,null,null,null,null,null,'success','{}'::jsonb);
 exception when insufficient_privilege then return;end;
 raise exception 'ASSERTION: producer forged human action %',action;
end $$;
set local role agent_ledger_writer;
select pg_temp.producer_refused('ropa.recorded');
select pg_temp.producer_refused('policy.drafted');
select pg_temp.producer_refused('playbook.created');
select pg_temp.producer_refused('policy.reviewed');
select pg_temp.producer_refused('operator.request.cancelled');
reset role;
select pg_temp.ok((select count(*)=8 from public.audit_ledger where tenant_id=pg_temp.id(11)),
 'producer refusals append no human receipts');
set local role human_action_writer;
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(151),'ropa',pg_temp.ropa(),gen_random_uuid())=
 jsonb_build_object('data',null,'cancelled',true),'pending request receives durable cancellation fence');
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(151),'ropa',pg_temp.ropa(),gen_random_uuid())->>'cancelled'='true',
 'exact cancellation replay creates no additional receipt');
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),151)->>'error'='operation_cancelled','late original POST cannot pass cancellation fence');
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(151),'ropa',pg_temp.ropa()||'{"purpose":"Changed"}',gen_random_uuid())->>'error'='idempotency_conflict',
 'changed cancellation cannot steal exact request key');
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(2),pg_temp.id(151),'ropa',pg_temp.ropa(),gen_random_uuid())->>'error'='idempotency_conflict',
 'another actor cannot claim cancelled request');
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),'ropa',pg_temp.ropa(),gen_random_uuid())->'data'->>'id'=
 (select r->'data'->>'id' from workflow_fixture where k='ropa'),'already committed request returns record instead of cancellation');
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(5),pg_temp.id(152),'ropa',pg_temp.ropa(),gen_random_uuid())->>'error'='forbidden',
 'nonmember cannot cancel another tenant operation');
reset role;
select pg_temp.ok((select count(*)=1 from public.operator_workflow_cancellations where tenant_id=pg_temp.id(11)),
 'only one cancellation retained so far');
select pg_temp.ok((select count(*)=9 from public.audit_ledger where tenant_id=pg_temp.id(11)),
 'exactly one human cancellation receipt, without repeats or refusal effects');
select pg_temp.ok((select count(*)=1 from public.audit_ledger l join public.operator_workflow_cancellations c on c.tenant_id=l.tenant_id and c.receipt_id=l.id
 where c.tenant_id=pg_temp.id(11) and l.action_type='operator.request.cancelled' and l.actor_type='human' and l.actor_id=c.created_by::text
 and l.detail->>'payload_sha256'=c.payload_sha256),'cancellation commitment and human receipt linked');
-- Current membership is rechecked before replay/recovery, and cancelled
-- engagements cannot recover or replay source context under a former grant.
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
set local role human_action_writer;
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),101)->>'error'='forbidden','role downgrade refuses old write replay');
select pg_temp.ok(public.cancel_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(152),'ropa',pg_temp.ropa(),gen_random_uuid())->>'cancelled'='true',
 'downgraded current reader can safely cancel own unconfirmed request');
reset role;
update public.tenant_users set role='owner' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
update public.engagements set status='cancelled' where id=pg_temp.id(31);
set local role human_action_writer;
select pg_temp.ok(pg_temp.record('ropa',pg_temp.ropa(),101)->>'error'='context_refused','cancelled engagement blocks replay');
select pg_temp.ok(public.reconcile_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101))->>'error'='context_refused','cancelled engagement blocks recovery');
reset role;
select pg_temp.ok((select count(*)=7 from public.operator_workflow_records where tenant_id=pg_temp.id(11)),'all later refusals preserve immutable records');
rollback;
