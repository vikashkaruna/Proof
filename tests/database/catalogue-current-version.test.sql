-- Runs after the genuine SQL-only candidate-approval fixture in the same owned
-- transaction. No real Auth/MFA or retained operator decision is claimed.
create function pg_temp.current_request(n int,v text default '0.2.0') returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(n),'libraryVersion',v,'rowsHash',f->>'rowsHash','questionnaireDigest',f->>'questionnaireDigest','manifestSha256',f->>'manifestSha256','mappingVersion','public-evidence-1','reason','Select this approved catalogue for new assessments','confirmed',true,'transition','make_current','previousCurrentVersion',(select version from public.control_libraries where is_current))) from (select controller_security.catalogue161_fingerprint(v) f)x$$;
create function pg_temp.current_challenge(r text) returns uuid language plpgsql as $$declare c uuid:=gen_random_uuid();binding text;begin
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.catalogue-version.make-current',1,pg_temp.id(11)::text,pg_temp.id(1)::text,pg_temp.id(101)::text,encode(sha256(convert_to(r,'UTF8')),'hex'))),'UTF8')),'hex');
 insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at,satisfied_at,consumed_at,consumed_for,satisfied_with)
 values(c,pg_temp.id(1),pg_temp.id(11),pg_temp.id(41),'catalogue_adoption',r::jsonb->>'operationKey',binding,clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '4 minutes 50 seconds',clock_timestamp()-interval '1 second',clock_timestamp(),r::jsonb->>'operationKey','totp');return c;
end$$;
select pg_temp.ok(not exists(select 1 from public.control_libraries where version='0.2.0' and is_current),'content approval alone did not select current');
select pg_temp.ok(not has_function_privilege(r,'public.set_current_catalogue_version(uuid,uuid,uuid,text,uuid)','execute'),'no activation RPC for '||r) from unnest(array['anon','authenticated','service_role','agent_ledger_writer'])r;
-- A content-approval MFA challenge cannot be repurposed for current selection.
do $$declare r text:=pg_temp.current_request(61);c uuid;begin
 c:=pg_temp.challenge(1,r);
 perform set_config('role','human_action_writer',true);
 begin perform public.set_current_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);raise exception 'approval challenge activated current';exception when insufficient_privilege then null;end;
 perform set_config('role','none',true);
end$$;
-- A stale prior pointer is refused even when MFA is otherwise exact and fresh.
do $$declare r text;c uuid;begin
 r:=controller_security.canonical_questionnaire_json(jsonb_set(pg_temp.current_request(62)::jsonb,'{previousCurrentVersion}','"0.1.1"'));
 c:=pg_temp.current_challenge(r);
 perform set_config('role','human_action_writer',true);
 begin perform public.set_current_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);raise exception 'stale predecessor accepted';exception when unique_violation then null;end;
 perform set_config('role','none',true);
end$$;
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(71),pg_temp.id(11),'current-catalogue-estate','Current catalogue assessment estate');
do $$declare r text:=pg_temp.current_request(63);c uuid;reply jsonb;intake jsonb;frozen uuid;begin
 c:=pg_temp.current_challenge(r);
 perform set_config('role','human_action_writer',true);
 reply:=public.set_current_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);
 perform pg_temp.ok(reply->>'approved'='true' and reply->>'replayed'='false','current selection recorded');
 reply:=public.set_current_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);
 perform pg_temp.ok(reply->>'replayed'='true','current action exact replay');
 intake:=public.create_engagement_intake(pg_temp.id(11),pg_temp.id(1),'catalogue-current-assessment',pg_temp.id(72),'Corrected catalogue assessment','0.2.0',pg_temp.id(71),pg_temp.id(73));
 perform pg_temp.ok(intake->>'library_version'='0.2.0' and intake->>'receipt' is not null,'approved current catalogue usable through audited assessment intake');
 perform set_config('role','none',true);
 perform pg_temp.ok(public.read_current_catalogue_version()->>'version'='0.2.0','onboarding current reference returns approved corrected version');
 perform pg_temp.ok((select count(*) from public.control_libraries where is_current)=1 and (select is_current from public.control_libraries where version='0.2.0'),'exactly one current version');
 perform pg_temp.ok((select count(*) from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type::text='catalogue.current_version_changed')=1,'one selection receipt');
 -- Explicit rollback changes only the future default; accepted assessments stay frozen.
 r:=pg_temp.current_request(64,'0.1.1');c:=pg_temp.current_challenge(r);
 perform set_config('role','human_action_writer',true);
 reply:=public.set_current_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);
 perform set_config('role','none',true);
 perform pg_temp.ok((select is_current from public.control_libraries where version='0.1.1'),'previous approved version selectable as rollback');
 perform pg_temp.ok((select library_version from public.engagements where id=pg_temp.id(72))='0.2.0','accepted assessment retains corrected version after default rollback');
 perform pg_temp.ok((select count(*) from public.catalogue_current_version_events)=2,'two append-only selection events');
end$$;
select pg_temp.refused('update public.catalogue_current_version_events set request_text=request_text','current events immutable');
select pg_temp.refused('truncate public.catalogue_current_version_events','current events no truncate');
rollback;
