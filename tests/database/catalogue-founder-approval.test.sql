-- Synthetic SQL sessions/MFA only; actual live TOTP acceptance remains separate.
-- The native disposable harness emits the exact current TS candidate before this suite.
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('99161000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
create function pg_temp.refused(q text,m text) returns void language plpgsql as $$begin begin execute q;exception when others then return;end;raise exception 'ASSERTION: % was not refused',m;end$$;
create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
insert into auth.users(id,email) select pg_temp.id(n),'catalogue-'||n||'@example.invalid' from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'catalogue-'||n||'@example.invalid',n in(1,3) from generate_series(1,4)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'catalogue-161','Synthetic catalogue founder test');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'founder'),(pg_temp.id(11),pg_temp.id(2),'owner'),(pg_temp.id(11),pg_temp.id(3),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(4),'founder');
insert into auth.sessions(id,user_id,not_after) select pg_temp.id(100+n),pg_temp.id(n),null from generate_series(1,4)n;
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) select pg_temp.id(40+n),pg_temp.id(n),'totp','active','synthetic-sealed' from generate_series(1,4)n;
select pg_temp.ok(not exists(select 1 from public.approved_catalogue_versions where library_version='0.2.0'),'publication does not approve candidate');
select pg_temp.ok(not (select is_current from public.control_libraries where version='0.2.0'),'publication does not activate candidate');
select pg_temp.ok((select manifest_sha256 from public.catalogue_version_manifests where library_version='0.1.1')='3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6','legacy exact bytes unchanged');
select pg_temp.ok(controller_security.catalogue161_fingerprint('0.2.0')->>'controlCount'='46','candidate source matches all 46 published rows');
create function pg_temp.request(n int default 21) returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(n),'libraryVersion','0.2.0','rowsHash',f->>'rowsHash','questionnaireDigest',f->>'questionnaireDigest','manifestSha256',f->>'manifestSha256','mappingVersion','public-evidence-1','reason','Reviewed corrected source and mapping','confirmed',true)) from (select controller_security.catalogue161_fingerprint('0.2.0') f)x$$;
create function pg_temp.challenge(actor int,r text) returns uuid language plpgsql as $$declare c uuid:=gen_random_uuid();binding text;begin
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.catalogue-version.approve',1,pg_temp.id(11)::text,pg_temp.id(actor)::text,pg_temp.id(100+actor)::text,encode(sha256(convert_to(r,'UTF8')),'hex'))),'UTF8')),'hex');
 insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at,satisfied_at,consumed_at,consumed_for,satisfied_with)
 values(c,pg_temp.id(actor),pg_temp.id(11),pg_temp.id(40+actor),'catalogue_adoption',r::jsonb->>'operationKey',binding,clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '4 minutes 50 seconds',clock_timestamp()-interval '1 second',clock_timestamp(),r::jsonb->>'operationKey','totp');return c;
end$$;
-- Public and service credentials can neither approve nor directly modify any registry.
select pg_temp.ok(not has_function_privilege(r,'public.approve_catalogue_version(uuid,uuid,uuid,text,uuid)','execute'),'no approval RPC for '||r) from unnest(array['anon','authenticated','service_role','agent_ledger_writer'])r;
select pg_temp.ok(not has_table_privilege(r,'public.catalogue_version_approval_events',p),'no approval event '||p||' for '||r) from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'])r,unnest(array['insert','update','delete','truncate'])p;
select pg_temp.refused(format('select public.read_catalogue_versions(%L,%L,%L)',pg_temp.id(11),pg_temp.id(2),pg_temp.id(102)),'owner');
select pg_temp.refused(format('select public.read_catalogue_versions(%L,%L,%L)',pg_temp.id(11),pg_temp.id(3),pg_temp.id(103)),'internal analyst');
select pg_temp.refused(format('select public.read_catalogue_versions(%L,%L,%L)',pg_temp.id(11),pg_temp.id(4),pg_temp.id(104)),'external founder');
select pg_temp.refused(format('select public.preflight_catalogue_version_approval(%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),jsonb_set(pg_temp.request()::jsonb,'{manifestSha256}',to_jsonb(repeat('a',64)))::text),'changed manifest');
-- Missing MFA, wrong session, stale factor and altered reason cannot mint approval.
do $$declare r text:=pg_temp.request();c uuid;altered text;begin
 altered:=controller_security.canonical_questionnaire_json(jsonb_set(r::jsonb,'{reason}','"Different reason"'));
 perform set_config('role','human_action_writer',true);
 begin perform public.approve_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,pg_temp.id(999));raise exception 'missing challenge accepted';exception when insufficient_privilege then null;end;
 perform set_config('role','none',true);
 c:=pg_temp.challenge(1,r);
 perform set_config('role','human_action_writer',true);
 begin perform public.approve_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(102),r,c);raise exception 'wrong session accepted';exception when insufficient_privilege then null;end;
 begin perform public.approve_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),altered,c);raise exception 'changed reason accepted';exception when insufficient_privilege then null;end;
 perform set_config('role','none',true);
 update public.mfa_challenges set expires_at=clock_timestamp()-interval '1 second' where id=c;
 perform set_config('role','human_action_writer',true);
 begin perform public.approve_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);raise exception 'expired challenge accepted';exception when insufficient_privilege then null;end;
 perform set_config('role','none',true);
end$$;
-- Fresh, exact, internal founder approval is atomic and replay-safe.
do $$declare r text:=pg_temp.request(22);c uuid;v jsonb;current_version text;begin
 select version into current_version from public.control_libraries where is_current;
 c:=pg_temp.challenge(1,r);
 perform set_config('role','human_action_writer',true);
 v:=public.approve_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);
 perform pg_temp.ok(v->>'approved'='true' and v->>'replayed'='false','fresh approval');
 v:=public.approve_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);
 perform pg_temp.ok(v->>'replayed'='true','exact replay reads original receipt');
 perform set_config('role','none',true);
 perform pg_temp.ok((select count(*) from public.approved_catalogue_versions where library_version='0.2.0')=1,'one immutable approval');
 perform pg_temp.ok((select count(*) from public.catalogue_version_approval_events where library_version='0.2.0')=1,'one event');
 perform pg_temp.ok((select count(*) from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type::text='catalogue.version_approved')=1,'one ledger receipt');
 perform pg_temp.ok((select version from public.control_libraries where is_current) is not distinct from current_version,'approval does not activate library');
end$$;
select pg_temp.refused('update public.catalogue_version_manifests set manifest_text=manifest_text','manifest immutable');
select pg_temp.refused('delete from public.catalogue_version_approval_events','approval immutable');
select pg_temp.refused('truncate public.catalogue_version_approval_events','approval no truncate');
rollback;
