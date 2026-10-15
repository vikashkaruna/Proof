-- Fresh public v2 capture: actual PostgreSQL authority, atomicity and immutability.
-- Synthetic static fixture only, rolled back. No retained environment or network.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99133300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'website-v2-'||n||'@example.invalid' from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'website-v2-'||n||'@example.invalid',n=3 from generate_series(1,4)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'website-v2-a','A'),(pg_temp.id(12),'website-v2-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'viewer'),(pg_temp.id(11),pg_temp.id(3),'founder'),(pg_temp.id(11),pg_temp.id(4),'founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,status) values
('website-v2-published',now()-interval '1 day','synthetic','Fixture',0,'published'),
('website-v2-draft',now()-interval '1 day','synthetic','Fixture',0,'draft'),
('website-v2-future',now()+interval '1 day','synthetic','Fixture',0,'published');
insert into public.engagements(id,tenant_id,library_version,title) values
(pg_temp.id(21),pg_temp.id(11),'website-v2-published','A'),(pg_temp.id(22),pg_temp.id(12),'website-v2-published','B'),
(pg_temp.id(23),pg_temp.id(11),'website-v2-draft','Draft'),(pg_temp.id(24),pg_temp.id(11),'website-v2-future','Future');
create function pg_temp.payload() returns jsonb language sql as $$select jsonb_build_object(
'version',2,'extractorVersion','static-public-2','scope','bounded_public_pages','requiresHumanReview',true,'candidates','[]'::jsonb,'candidatesTruncated',false,
'pages',jsonb_build_array(
jsonb_build_object('page','root','state','examined','contentSha256',repeat('a',64),'truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','privacy','state','examined','contentSha256',repeat('b',64),'truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','contact','state','unavailable','truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','terms','state','unexamined','truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','consent','state','examined','contentSha256',repeat('c',64),'truncated',false,'coverageReasons','[]'::jsonb)))$$;
create function pg_temp.sources() returns jsonb language sql as $$select jsonb_build_array(
jsonb_build_object('page','root','state','examined','requestedUrl','https://public.org/','finalUrl','https://public.org/','contentSha256',repeat('a',64)),
jsonb_build_object('page','privacy','state','examined','requestedUrl','https://public.org/privacy','finalUrl','https://public.org/privacy','contentSha256',repeat('b',64)),
jsonb_build_object('page','contact','state','unavailable','requestedUrl','https://public.org/contact','finalUrl',null,'contentSha256',null),
jsonb_build_object('page','terms','state','unexamined','requestedUrl',null,'finalUrl',null,'contentSha256',null),
jsonb_build_object('page','consent','state','examined','requestedUrl','https://public.org/consent','finalUrl','https://public.org/consent','contentSha256',repeat('c',64)))$$;
create function pg_temp.result() returns jsonb language sql as $$select jsonb_build_object('requestedUrl','https://public.org/','finalUrl','https://public.org/','checkedAt',now(),'status','checked','httpStatus',200,'bytes',3,'contentSha256',repeat('a',64),'title','Synthetic public page','headings','[]'::jsonb,'publicLinks','[]'::jsonb,'auditPages',jsonb_build_array(jsonb_build_object('kind','privacy','status','checked','requestedUrl','https://public.org/privacy','finalUrl','https://public.org/privacy','contentSha256',repeat('b',64)),jsonb_build_object('kind','contact','status','unavailable','requestedUrl','https://public.org/contact','errorCode','unreachable')),'observations',jsonb_build_array(jsonb_build_object('kind','privacy','status','retrieved'),jsonb_build_object('kind','contact','status','unavailable'),jsonb_build_object('kind','terms','status','not_linked')))$$;
create function pg_temp.capture(o jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;t text;prior text:=current_user;
begin
 t:=coalesce(o->>'payloadText',controller_security.canonical_questionnaire_json(coalesce(o->'payload',pg_temp.payload())));
 set local role human_action_writer;
 r:=public.record_public_website_control_capture(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),coalesce((o->>'key')::uuid,gen_random_uuid()),'https://public.org/','https://public.org/',coalesce(o->'result',pg_temp.result()),'axiom-public-evidence-v2-canonical-json-1',t,coalesce(o->>'hash',encode(sha256(convert_to(t,'UTF8')),'hex')),coalesce(o->'sources',pg_temp.sources()));
 execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.read(c uuid,e uuid default pg_temp.id(21),a uuid default pg_temp.id(1),t uuid default pg_temp.id(11)) returns jsonb language plpgsql as $$
declare r jsonb;prior text:=current_user;
begin set local role service_role;r:=public.read_public_website_control_review(t,a,e,c);execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.refused(o jsonb,m text) returns void language plpgsql as $$
declare n bigint;checks bigint;begin
 select count(*) into n from public.audit_ledger;select count(*) into checks from public.public_website_checks;
 begin perform pg_temp.capture(o);raise exception 'ASSERTION: accepted %',m;
 exception when insufficient_privilege or invalid_parameter_value or check_violation then null;end;
 perform pg_temp.ok((select count(*)=n from public.audit_ledger),'no ledger append on refused '||m);
 perform pg_temp.ok((select count(*)=checks from public.public_website_checks),'no check on refused '||m);
end$$;
-- Only the constrained writer executes capture. All direct evidence DML refused.
do $$declare r text;begin
foreach r in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
 perform pg_temp.ok(not has_table_privilege(r,'public.public_website_control_evidence','INSERT') and not has_table_privilege(r,'public.public_website_control_evidence','UPDATE') and not has_table_privilege(r,'public.public_website_control_evidence','DELETE'),'no direct DML '||r);
 if r<>'human_action_writer' then perform pg_temp.ok(not has_function_privilege(r,'public.record_public_website_control_capture(uuid,uuid,uuid,text,text,jsonb,text,text,text,jsonb)','EXECUTE'),'capture restricted '||r);end if;
end loop;
end$$;
select pg_temp.refused(jsonb_build_object('actor',pg_temp.id(2)),'viewer');
select pg_temp.refused(jsonb_build_object('actor',pg_temp.id(4)),'noninternal founder');
select pg_temp.refused(jsonb_build_object('tenant',pg_temp.id(12)),'cross tenant');
select pg_temp.refused(jsonb_build_object('hash',repeat('d',64)),'payload digest mismatch');
select pg_temp.refused(jsonb_build_object('payload',jsonb_set(pg_temp.payload(),'{pages,0,contentSha256}',to_jsonb(repeat('d',64)))),'root mismatch');
select pg_temp.refused(jsonb_build_object('payload',jsonb_set(pg_temp.payload(),'{pages,1,contentSha256}',to_jsonb(repeat('d',64)))),'notice mismatch');
select pg_temp.refused(jsonb_build_object('payload',jsonb_set(pg_temp.payload(),'{pages,4,page}','"root"')),'duplicate page');
select pg_temp.refused(jsonb_build_object('sources',jsonb_set(pg_temp.sources(),'{3,requestedUrl}','"https://invented.org/terms"')),'unexamined invented URL');
select pg_temp.refused(jsonb_build_object('sources',jsonb_set(pg_temp.sources(),'{4,finalUrl}','"https://other.org/consent"')),'offsite consent provenance');
select pg_temp.refused(jsonb_build_object('sources',jsonb_set(pg_temp.sources(),'{1,requestedUrl}','"https://public.org/invented"')),'notice URL mismatch');
-- Fault after both ledger appends must roll back the entire capture call.
create function pg_temp.fail_evidence_insert() returns trigger language plpgsql as $$begin raise exception 'fixture rejects companion insert' using errcode='22023';end$$;
create trigger v2_fixture_reject_insert before insert on public.public_website_control_evidence for each row execute function pg_temp.fail_evidence_insert();
select pg_temp.refused('{}'::jsonb,'late companion insert failure rolls back check and ledger');
drop trigger v2_fixture_reject_insert on public.public_website_control_evidence;
-- Successful check, companion and two ledger records are one atomic operation.
create temporary table v2_saved as select pg_temp.capture(jsonb_build_object('key',pg_temp.id(51))) as record;
do $$declare c uuid;r jsonb;receipt bigint;n bigint;begin
 c:=((select record from v2_saved)->>'id')::uuid;
 perform pg_temp.ok((select count(*)=1 from public.public_website_checks where id=c),'one check');
 perform pg_temp.ok((select count(*)=1 from public.public_website_control_evidence where check_id=c),'one evidence');
 perform pg_temp.ok((select count(*)=2 from public.audit_ledger where tenant_id=pg_temp.id(11) and correlation_id=pg_temp.id(51)),'atomic two ledger records');
 select capture_receipt into receipt from public.public_website_control_evidence where check_id=c;
 perform pg_temp.ok(exists(select 1 from public.audit_ledger where id=receipt and tenant_id=pg_temp.id(11) and action_type='connector.website.evidence_captured' and result='success'),'capture receipt');
 r:=pg_temp.read(c);perform pg_temp.ok(not r?'error' and r->>'checkId'=c::text and r->>'captureReceipt'=receipt::text,'authorized read');
 perform pg_temp.ok(pg_temp.read(c,pg_temp.id(22))->>'error'='context_refused','foreign engagement');
 perform pg_temp.ok(pg_temp.read(c,pg_temp.id(21),pg_temp.id(1),pg_temp.id(12))?'error','foreign tenant');
 perform pg_temp.ok(pg_temp.read(c,pg_temp.id(23))->>'error'='catalogue_unavailable','draft catalogue refused');
 perform pg_temp.ok(pg_temp.read(c,pg_temp.id(24))->>'error'='catalogue_unavailable','future catalogue refused');
 begin update public.public_website_control_evidence set payload_text=payload_text||' ' where check_id=c;raise exception 'ASSERTION: evidence update accepted';exception when insufficient_privilege then null;end;
 begin delete from public.public_website_control_evidence where check_id=c;raise exception 'ASSERTION: evidence delete accepted';exception when insufficient_privilege then null;end;
 update public.users set is_axiom_internal=false where id=pg_temp.id(3);
 perform pg_temp.ok(pg_temp.read(c,pg_temp.id(21),pg_temp.id(3))->>'error'='forbidden','offboard founder read');
 perform pg_temp.refused(jsonb_build_object('actor',pg_temp.id(3)),'offboard founder capture');
 delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
 perform pg_temp.ok(pg_temp.read(c)->>'error'='forbidden','revoked membership read');
 perform pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.id(11))),'ledger chain intact');
end$$;
-- Parent source rows and child table-level removal must also be immutable.
-- Exercise both before asserting, so the causal baseline records both gaps.
do $$declare c uuid;parent_denied boolean:=false;truncate_denied boolean:=false;begin
 c:=((select record from v2_saved)->>'id')::uuid;
 begin update public.public_website_checks set result=jsonb_set(result,'{contentSha256}',to_jsonb(repeat('d',64))) where id=c;
 exception when insufficient_privilege then parent_denied:=true;end;
 begin truncate public.public_website_control_evidence;
 exception when insufficient_privilege then truncate_denied:=true;end;
 perform pg_temp.ok(parent_denied and truncate_denied,'captured parent update denied='||parent_denied::text||', child truncate denied='||truncate_denied::text);
end$$;
-- Old hash-only checks require explicit fresh capture, never implicit backfill.
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,final_url,status,result) values(pg_temp.id(61),pg_temp.id(11),pg_temp.id(1),pg_temp.id(62),'https://public.org/','https://public.org/','checked',pg_temp.result());
select pg_temp.ok(pg_temp.read(pg_temp.id(61))->>'error'='website_recapture_required','legacy check recapture required');
rollback;
