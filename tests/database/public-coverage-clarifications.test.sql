-- Synthetic SQL session/factor stand-ins, disposable PostgreSQL only. No browser MFA claim.
create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
alter table auth.sessions add column if not exists created_at timestamptz not null default clock_timestamp();
insert into auth.sessions(id,user_id,not_after)select pg_temp.id(100+n),pg_temp.id(n),null from generate_series(1,4)n;
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)select pg_temp.id(40+n),pg_temp.id(n),'totp','active','synthetic-sealed'from generate_series(1,4)n;
insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)select pg_temp.id(n),pg_temp.id(100+n)::text,pg_temp.id(40+n),clock_timestamp()-interval'1 second',clock_timestamp()+interval'15 minutes'from generate_series(1,4)n;
create temporary table coverage179_saved(k text primary key,v jsonb);
grant select,insert,update on coverage179_saved to human_action_writer,service_role;
insert into coverage179_saved values('capture',pg_temp.capture(jsonb_build_object('key',pg_temp.id(17901))));
create function pg_temp.coverage179_request(op int,prior uuid default null)returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(op),'engagementId',pg_temp.id(21),'checkId',v->>'id','payloadSha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(pg_temp.payload()),'UTF8')),'hex'),'expectedPreviousRevisionId',prior,'clarifications',jsonb_build_array(
jsonb_build_object('page','contact','sourceState','unavailable','sourceTruncated',false,'reasonCategory','access_blocked','reason','Owner is investigating why the contact page was unreachable.','proposedPublicUrl',null),
jsonb_build_object('page','terms','sourceState','unexamined','sourceTruncated',false,'reasonCategory','needs_investigation','reason','Owner must identify and publish the applicable terms page.','proposedPublicUrl','https://public.org/terms'))))from coverage179_saved where k='capture'$$;
create function pg_temp.coverage179_submit(r text,a uuid default pg_temp.id(1),s uuid default pg_temp.id(101),t uuid default pg_temp.id(11))returns jsonb language plpgsql as $$declare v jsonb;begin set local role human_action_writer;v:=public.submit_public_coverage_clarification(t,a,s,r);reset role;return v;exception when others then reset role;raise;end$$;
create function pg_temp.coverage179_read(op uuid default null)returns jsonb language plpgsql as $$declare v jsonb;c uuid:=((select saved.v from coverage179_saved saved where saved.k='capture')->>'id')::uuid;h text:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(pg_temp.payload()),'UTF8')),'hex');begin set local role service_role;v:=public.read_public_coverage_clarification(pg_temp.id(11),pg_temp.id(1),pg_temp.id(21),c,h,op);reset role;return v;end$$;
select pg_temp.ok(jsonb_array_length(controller_security.coverage179_pages('{"pages":[{"page":"root","state":"examined","truncated":false}]}'::jsonb))=5,'missing historical pages normalize without altering source');
insert into coverage179_saved values('first',pg_temp.coverage179_submit(pg_temp.coverage179_request(17902)));
select pg_temp.ok((select v#>>'{record,receiptId}'is not null and v->>'replayed'='false'from coverage179_saved where k='first'),'owner declaration retained');
select pg_temp.ok(pg_temp.coverage179_submit(pg_temp.coverage179_request(17902))->>'replayed'='true','exact operation replay');
select pg_temp.ok(pg_temp.coverage179_read()->'record'=(select v->'record'from coverage179_saved where k='first'),'read current exact receipt');
select pg_temp.ok(pg_temp.coverage179_read(pg_temp.id(17902))->'record'=(select v->'record'from coverage179_saved where k='first'),'operation lookup exact receipt');
select pg_temp.ok(pg_temp.coverage179_submit(pg_temp.coverage179_request(17903))->>'error'='stale_revision','optimistic stale root refused');
select pg_temp.ok(pg_temp.coverage179_submit(replace(pg_temp.coverage179_request(17902),'Owner must identify','Owner should identify'))->>'error'='idempotency_conflict','same key changed bytes refused');
select pg_temp.ok(pg_temp.coverage179_submit(controller_security.canonical_questionnaire_json(jsonb_set(pg_temp.coverage179_request(17903)::jsonb,'{payloadSha256}',to_jsonb(repeat('d',64)))))->>'error'='source_refused','altered source digest refused');
select pg_temp.ok(pg_temp.coverage179_submit(controller_security.canonical_questionnaire_json(jsonb_set(pg_temp.coverage179_request(17903)::jsonb,'{clarifications}','[]')))->>'error'='explanation_required','missing critical page explanations refused');
select pg_temp.ok(pg_temp.coverage179_submit(replace(pg_temp.coverage179_request(17903),'https://public.org/terms','https://other.org/terms'))->>'error'='invalid_record','offsite owner URL refused');
select pg_temp.ok(pg_temp.coverage179_submit(replace(pg_temp.coverage179_request(17903),'"sourceState":"unavailable"','"sourceState":"examined"'))->>'error'='source_refused','declaration cannot relabel unavailable evidence');
select pg_temp.ok(pg_temp.coverage179_submit(pg_temp.coverage179_request(17903),pg_temp.id(2),pg_temp.id(102))->>'error'='forbidden','viewer declaration refused');
insert into coverage179_saved values('second',pg_temp.coverage179_submit(pg_temp.coverage179_request(17904,(select(v#>>'{record,id}')::uuid from coverage179_saved where k='first'))));
select pg_temp.ok((select v#>>'{record,id}'is not null from coverage179_saved where k='second'),'versioned successor retained');
select pg_temp.ok(pg_temp.coverage179_read()->'record'=(select v->'record'from coverage179_saved where k='second'),'current head advances');
select pg_temp.ok(pg_temp.coverage179_read(pg_temp.id(17902))->'record'=(select v->'record'from coverage179_saved where k='first'),'historical operation unchanged');
do $$declare before_count bigint;begin
 select count(*)into before_count from public.audit_ledger;
 begin perform controller_security.coverage179_pages('{"pages":[{"page":"root"},{"page":"root"}]}'::jsonb);raise exception 'duplicate page accepted';exception when raise_exception then if sqlerrm='duplicate page accepted'then raise;end if;end;
 begin perform controller_security.coverage179_pages('{"pages":[{"page":"invented"}]}'::jsonb);raise exception 'unknown page accepted';exception when raise_exception then if sqlerrm='unknown page accepted'then raise;end if;end;
 begin perform pg_temp.coverage179_submit(pg_temp.coverage179_request(17905),pg_temp.id(1),pg_temp.id(102));raise exception 'wrong session accepted';exception when insufficient_privilege then null;end;
 begin update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.id(101);perform pg_temp.coverage179_submit(pg_temp.coverage179_request(17905));raise exception 'expired session accepted';exception when insufficient_privilege then null;end;
 begin perform pg_temp.coverage179_submit(pg_temp.coverage179_request(17905),pg_temp.id(1),pg_temp.id(101),pg_temp.id(12));raise exception 'cross tenant accepted';exception when insufficient_privilege then null;end;
 perform pg_temp.ok((select count(*)=before_count from public.audit_ledger),'refused operations append no ledger records');
 begin update controller_security.public_coverage_clarifications set request_text=request_text||' ';raise exception 'update accepted';exception when insufficient_privilege then null;end;
 begin delete from controller_security.public_coverage_clarifications;raise exception 'delete accepted';exception when insufficient_privilege then null;end;
 begin truncate controller_security.public_coverage_clarifications;raise exception 'truncate accepted';exception when insufficient_privilege then null;end;
 perform pg_temp.ok((select count(*)=2 from controller_security.public_coverage_clarifications),'append only revisions retained');
 perform pg_temp.ok((select count(*)=2 from public.audit_ledger where action_type='public_coverage.owner_clarified'),'one receipt per new declaration, no replay duplicates');
 perform pg_temp.ok((select payload_text=controller_security.canonical_questionnaire_json(pg_temp.payload()) from public.public_website_control_evidence where check_id=((select saved.v from coverage179_saved saved where saved.k='capture')->>'id')::uuid),'owner explanations never alter original source bytes');
 perform pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.id(11))),'ledger chain intact');
end$$;
-- A partial examined root remains incomplete and requires its own explanation.
create temporary table coverage179_partial as select jsonb_set(jsonb_set(pg_temp.payload(),'{pages,0,truncated}','true'),'{pages,0,coverageReasons}','["unsupported_foreign_markup"]') as payload;
grant select on coverage179_partial to human_action_writer;
create or replace function pg_temp.payload()returns jsonb language sql as $$select payload from coverage179_partial$$;
update coverage179_saved set v=pg_temp.capture(jsonb_build_object('key',pg_temp.id(17906)))where k='capture';
select pg_temp.ok(pg_temp.coverage179_submit(pg_temp.coverage179_request(17907))->>'error'='explanation_required','partial SVG root requires its own owner explanation');
select pg_temp.ok(pg_temp.coverage179_submit(controller_security.canonical_questionnaire_json(jsonb_set(pg_temp.coverage179_request(17907)::jsonb,'{clarifications}',(pg_temp.coverage179_request(17907)::jsonb->'clarifications')||jsonb_build_array(jsonb_build_object('page','root','sourceState','examined','sourceTruncated',true,'reasonCategory','interactive_content','reason','Owner will verify the excluded SVG and remaining root content.','proposedPublicUrl',null)))))->'record'is not null,'partial root declaration is retained without changing examined partial evidence');
rollback;
