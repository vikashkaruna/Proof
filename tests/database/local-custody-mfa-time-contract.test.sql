-- 0150 database-clock custody MFA. Synthetic SQL session/MFA fixture only; NOT real Auth acceptance.
begin;
-- The ordinary SQL harness has minimal auth.users only. This transaction-scoped
-- schema stand-in is created ONLY when absent; real GoTrue acceptance is separate.
do $fixture150_auth$declare prior text:=current_user;begin
 if to_regclass('auth.sessions') is null then
  set local role postgres;
  create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
  execute format('set local role %I',prior);
 end if;
end $fixture150_auth$;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('99150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'custody-'||n||'@example.invalid' from generate_series(1,5)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'custody-'||n||'@example.invalid',n in(2,3) from generate_series(1,5)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'custody-143-a','Synthetic custody A'),(pg_temp.id(12),'custody-143-b','Synthetic custody B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'founder'),(pg_temp.id(11),pg_temp.id(3),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(4),'viewer'),(pg_temp.id(12),pg_temp.id(5),'owner');
insert into auth.sessions(id,user_id,not_after) select pg_temp.id(100+n),pg_temp.id(n),null from generate_series(1,5)n;
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) select pg_temp.id(40+n),pg_temp.id(n),'totp','active','synthetic-sealed' from generate_series(1,5)n;
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://local.axiom/agent/parikshan','active');
create function pg_temp.policy() returns jsonb language sql as $$select jsonb_build_object('version',1,'policyId',pg_temp.id(21),'tenantId',pg_temp.id(11),'mode','operator_managed','nominatedOperatorId',pg_temp.id(3),'targetWorkloadId',pg_temp.id(31),'servicePrincipals',jsonb_build_object('producer','spiffe://local.axiom/service/assessment-dispatch-producer','controller','spiffe://local.axiom/controller/assessment'),'validity',jsonb_build_object('kind','until_revoked','reviewDueAt',1),'actionClass','assessment_dispatch_key_custody','keyPolicy',jsonb_build_object('primary','axiom-local-dispatch://'||pg_temp.id(11)||'/'||pg_temp.id(21)||'/versions/1','readable',jsonb_build_array('axiom-local-dispatch://'||pg_temp.id(11)||'/'||pg_temp.id(21)||'/versions/1')),'keyPolicySha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local.dispatch.policy',1,pg_temp.id(11)::text,pg_temp.id(21)::text,'operator_managed',jsonb_build_object('kind','until_revoked','reviewDueAt',1),'axiom-local-dispatch://'||pg_temp.id(11)||'/'||pg_temp.id(21)||'/versions/1',jsonb_build_array('axiom-local-dispatch://'||pg_temp.id(11)||'/'||pg_temp.id(21)||'/versions/1'))),'UTF8')),'hex'),'deploymentBindingSha256',repeat('b',64),'reason','Explicit local custody limitation','acceptedLimitations',jsonb_build_array('hardware_backing_unverified'),'statutoryComplianceAsserted',false,'ownershipVerified',false)$$;
-- Fixture fingerprint is derived from the exact canonical public policy fields.
select pg_temp.ok(controller_security.local143_policy(controller_security.canonical_questionnaire_json(pg_temp.policy()))=pg_temp.policy(),'TS key fingerprint matches SQL canonical derivation');
-- Syntax parity only: actual issuer/peer must still pin the configured trusted principal.
do $$declare d text;k text;v jsonb;path text;begin
 foreach d in array array['..','.local','local.','-local','local-','a..b','LOCAL','a b',repeat('a',256)] loop
  foreach k in array array['producer','controller'] loop
   path:=case k when 'producer' then 'service/assessment-dispatch-producer' else 'controller/assessment' end;
   v:=jsonb_set(pg_temp.policy(),array['servicePrincipals',k],to_jsonb('spiffe://'||d||'/'||path));
   begin perform controller_security.local143_policy(controller_security.canonical_questionnaire_json(v));
    raise exception 'invalid custody service domain accepted';
   exception when invalid_parameter_value then null;end;
  end loop;
 end loop;
 foreach d in array array['a','local.axiom','a-b.c',repeat('a',255)] loop
  v:=jsonb_set(jsonb_set(pg_temp.policy(),'{servicePrincipals,producer}',to_jsonb('spiffe://'||d||'/service/assessment-dispatch-producer')),'{servicePrincipals,controller}',to_jsonb('spiffe://'||d||'/controller/assessment'));
  perform pg_temp.ok(controller_security.local143_policy(controller_security.canonical_questionnaire_json(v))=v,'canonical service domain accepted');
 end loop;
end$$;
create function pg_temp.request(k int,transition text,previous uuid default null) returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(k),'transition',transition,'policyText',controller_security.canonical_questionnaire_json(pg_temp.policy()),'policySha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(pg_temp.policy()),'UTF8')),'hex'),'previousEventId',previous,'nextReviewDueAt',case when transition='review' then to_jsonb(floor(extract(epoch from clock_timestamp())*1000)::bigint+86400000) else 'null'::jsonb end,'reason','Explicit synthetic custody decision','confirmed',true))$$;
create function pg_temp.challenge(actor int,request_text text) returns uuid language plpgsql as $$declare c uuid:=gen_random_uuid();r jsonb:=request_text::jsonb;binding text;begin
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local-custody.transition',1,pg_temp.id(11)::text,pg_temp.id(actor)::text,pg_temp.id(100+actor)::text,encode(sha256(convert_to(request_text,'UTF8')),'hex'))),'UTF8')),'hex');
 insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at,satisfied_at,consumed_at,consumed_for,satisfied_with) values(c,pg_temp.id(actor),pg_temp.id(11),pg_temp.id(40+actor),'local_custody_policy',r->>'operationKey',binding,clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '4 minutes 50 seconds',clock_timestamp()-interval '1 second',clock_timestamp(),r->>'operationKey','totp');return c;
end$$;
create function pg_temp.write(request_text text,actor int,challenge uuid default null) returns jsonb language plpgsql as $$declare c uuid:=coalesce(challenge,pg_temp.challenge(actor,request_text));v jsonb;prior text:=current_user;begin
 set local role human_action_writer;v:=public.record_local_custody_policy_event(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),request_text,c);execute format('set local role %I',prior);return v;
 exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.refused(request_text text,actor int,code text default '42501',challenge uuid default null) returns void language plpgsql as $$declare n bigint;begin
 select count(*) into n from public.audit_ledger;
 begin perform pg_temp.write(request_text,actor,challenge);set constraints all immediate;exception when others then if sqlstate=code then perform pg_temp.ok((select count(*)=n from public.audit_ledger),'refusal leaves ledger unchanged');return;end if;raise;end;
 raise exception 'unexpected custody authorization';end$$;

-- Fixture calls model the already completed BFF proof by charging exactly one
-- attempt; this is SQL contract coverage, NOT TOTP/browser proof.
create function pg_temp.binding(request_text text,actor int) returns text language sql as $$select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local-custody.transition',1,pg_temp.id(11)::text,pg_temp.id(actor)::text,pg_temp.id(100+actor)::text,encode(sha256(convert_to(request_text,'UTF8')),'hex'))),'UTF8')),'hex')$$;
create function pg_temp.issue(actor int,request_text text,ttl integer default 300000) returns uuid language plpgsql as $$declare v jsonb;prior text:=current_user;binding_digest text:=pg_temp.binding(request_text,actor);operation_key uuid:=(request_text::jsonb->>'operationKey')::uuid;begin
 set local role service_role;
 v:=public.issue_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),operation_key,binding_digest,ttl);
 execute format('set local role %I',prior);return (v->>'id')::uuid;
 exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.prove(actor int,request_text text,c uuid) returns jsonb language plpgsql as $$declare v jsonb;prior text:=current_user;binding_digest text:=pg_temp.binding(request_text,actor);operation_key uuid:=(request_text::jsonb->>'operationKey')::uuid;begin
 update public.mfa_challenges set attempts=1 where id=c;
 set local role service_role;
 v:=public.satisfy_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),operation_key,binding_digest,c,1,'totp');
 v:=public.consume_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),operation_key,binding_digest,c,1,operation_key);
 execute format('set local role %I',prior);return v;
 exception when others then execute format('set local role %I',prior);raise;end$$;
-- Negative legacy clock constructions remain refused by the UNCHANGED writer.
do $$declare q text:=pg_temp.request(61,'request');c uuid;begin
 c:=pg_temp.challenge(1,q);update public.mfa_challenges set expires_at=created_at+interval '302 seconds' where id=c;perform pg_temp.refused(q,1,'42501',c);
 c:=pg_temp.challenge(1,q);update public.mfa_challenges set satisfied_at=clock_timestamp()+interval '2 seconds',consumed_at=clock_timestamp()+interval '2 seconds' where id=c;perform pg_temp.refused(q,1,'42501',c);
 c:=pg_temp.challenge(1,q);update public.mfa_challenges set consumed_at=clock_timestamp()+interval '2 seconds' where id=c;perform pg_temp.refused(q,1,'42501',c);
end$$;
-- Exact shared issue instant, no host timestamp argument and no TTL renewal.
do $$declare q text:=pg_temp.request(61,'request');c uuid;row public.mfa_challenges;v jsonb;begin
 c:=pg_temp.issue(1,q);select * into row from public.mfa_challenges where id=c;
 perform pg_temp.ok(row.expires_at-row.created_at=interval '300000 milliseconds','exact maximum TTL from one DB instant');
 perform pg_temp.ok(row.purpose::text='local_custody_policy' and row.attempts=0 and row.satisfied_at is null and row.consumed_at is null,'issue purpose and initial state');
 v:=pg_temp.prove(1,q,c);
 perform pg_temp.ok((select satisfied_at>=created_at and consumed_at>=satisfied_at and expires_at=row.expires_at from public.mfa_challenges where id=c),'database ordering and original expiry preserved');
 perform pg_temp.ok((select count(*) from jsonb_object_keys(v))=4 and v->>'id'=c::text and v->>'factor_id'=pg_temp.id(41)::text,'consume strict response no credential fields');
 perform pg_temp.ok(pg_temp.write(q,1,c)->>'state'='recorded','real RPC sequence passes unchanged143 authority');
end$$;
set constraints all immediate;set constraints all deferred;
-- Same DB-time chain also passes the UNCHANGED cancellation domain/writer.
do $$declare q text;b text;digest text;c uuid;v jsonb;begin
 q:=pg_temp.request(89,'request');
 b:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(90),'originalRequestText',q,'reason','Explicit synthetic cancellation','confirmed',true));
 digest:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local-custody.cancel',1,pg_temp.id(11)::text,pg_temp.id(1)::text,pg_temp.id(101)::text,encode(sha256(convert_to(b,'UTF8')),'hex'))),'UTF8')),'hex');
 set local role service_role;
 v:=public.issue_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(90),digest,300000);reset role;c:=(v->>'id')::uuid;
 update public.mfa_challenges set attempts=1 where id=c;
 set local role service_role;
 perform public.satisfy_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(90),digest,c,1,'totp');
 perform public.consume_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(90),digest,c,1,pg_temp.id(90));reset role;
 set local role human_action_writer;v:=public.record_local_custody_policy_cancellation(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),b,c);reset role;
 perform pg_temp.ok(v->>'state'='cancelled','real RPC sequence passes unchanged149 authority');
end$$;
set constraints all immediate;set constraints all deferred;
-- Invalid TTL fails before creating any challenge.
do $$declare n bigint;ttl int;begin
 select count(*) into n from public.mfa_challenges;
 foreach ttl in array array[0,-1,300001] loop
  begin perform pg_temp.issue(1,pg_temp.request(70,'request'),ttl);raise exception 'invalid TTL accepted';exception when invalid_parameter_value then null;end;
 end loop;
 perform pg_temp.ok((select count(*)=n from public.mfa_challenges),'invalid TTL no row');
end$$;
-- Scope, session, factor, expiry and CAS remain fail-closed. Each subtransaction
-- rolls its synthetic fixture mutation back after the expected refusal.
do $$declare q text:=pg_temp.request(71,'request');binding_digest text:=pg_temp.binding(q,1);c uuid;mode text;begin
 c:=pg_temp.issue(1,q);update public.mfa_challenges set attempts=1 where id=c;
 foreach mode in array array['session','factor','tenant','digest','attempt','expired','retired','future-created','wrong-purpose'] loop
  begin
   if mode='expired' then update public.mfa_challenges set created_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '1 second' where id=c;end if;
   if mode='retired' then update public.user_mfa_factors set status='revoked',revoked_at=clock_timestamp() where id=pg_temp.id(41);end if;
   if mode='future-created' then update public.mfa_challenges set created_at=clock_timestamp()+interval '1 second' where id=c;end if;
   if mode='wrong-purpose' then update public.mfa_challenges set purpose='login' where id=c;end if;
   set local role service_role;
   perform public.satisfy_local_custody_mfa_challenge(case when mode='tenant' then pg_temp.id(12) else pg_temp.id(11) end,pg_temp.id(1),case when mode='session' then pg_temp.id(102) else pg_temp.id(101) end,case when mode='factor' then pg_temp.id(42) else pg_temp.id(41) end,pg_temp.id(71),case when mode='digest' then repeat('a',64) else binding_digest end,c,case when mode='attempt' then 2 else 1 end,'totp');
   reset role;raise exception 'guard accepted: %',mode;
  exception when insufficient_privilege then reset role;end;
 end loop;
 set local role service_role;
 perform public.satisfy_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(71),binding_digest,c,1,'totp');reset role;
 begin set local role service_role;perform public.satisfy_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(71),binding_digest,c,1,'totp');raise exception 'second satisfaction accepted';exception when insufficient_privilege then reset role;end;
 foreach mode in array array['future-satisfied','expired-session','consumed','attempt-moved'] loop
  begin
   if mode='future-satisfied' then update public.mfa_challenges set satisfied_at=clock_timestamp()+interval '1 second' where id=c;end if;
   if mode='expired-session' then update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.id(101);end if;
   if mode='consumed' then update public.mfa_challenges set consumed_at=clock_timestamp() where id=c;end if;
   if mode='attempt-moved' then update public.mfa_challenges set attempts=2 where id=c;end if;
   set local role service_role;perform public.consume_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(71),binding_digest,c,1,pg_temp.id(71));reset role;
   raise exception 'consume guard accepted: %',mode;
  exception when insufficient_privilege then reset role;end;
 end loop;
 set local role service_role;perform public.consume_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(71),binding_digest,c,1,pg_temp.id(71));reset role;
 begin set local role service_role;perform public.consume_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(71),binding_digest,c,1,pg_temp.id(71));raise exception 'second consumption accepted';exception when insufficient_privilege then reset role;end;
end$$;
-- Functions are not browser/human-writer/agent/verifier APIs; even owner direct
-- calls without SET ROLE service_role fail the explicit current-role check.
do $$declare signature text;role_name text;begin
 foreach signature in array array['public.issue_local_custody_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer)','public.satisfy_local_custody_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text)','public.consume_local_custody_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid)'] loop
  perform pg_temp.ok(has_function_privilege('service_role',signature,'EXECUTE'),'service role execute granted');
  foreach role_name in array array['anon','authenticated','human_action_writer','axiom_local_custody_verifier','axiom_local_custody_issuer'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'non-service execute refused');end if;
  end loop;
 end loop;
 begin perform public.issue_local_custody_mfa_challenge(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.id(41),pg_temp.id(79),repeat('a',64),300000);raise exception 'direct owner RPC accepted';exception when insufficient_privilege then null;end;
end$$;
rollback;
