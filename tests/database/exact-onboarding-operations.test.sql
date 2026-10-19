-- Native synthetic human/session authority fixture; no GoTrue login/customer/runtime claims.
begin;
create function pg_temp.check178(ok boolean,label text)returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception '0178 assertion: %',label;end if;end $$;
create function pg_temp.u178(n integer)returns uuid language sql immutable as $$select ('00000000-0000-4000-8178-'||lpad(n::text,12,'0'))::uuid$$;
insert into auth.users(id,email)select pg_temp.u178(n),'synthetic178-'||n||'@test.invalid'from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal)select pg_temp.u178(n),'synthetic178-'||n||'@test.invalid',n=2 from generate_series(1,4)n;
insert into auth.sessions(id,user_id,not_after)select pg_temp.u178(100+n),pg_temp.u178(n),null from generate_series(1,4)n;
insert into auth.sessions(id,user_id,not_after)values(pg_temp.u178(201),pg_temp.u178(1),null);
insert into public.onboarding_entitlements(user_id,max_owned_tenants,allowed_tiers,granted_by,grant_reason,valid_until)
 select pg_temp.u178(n),2,array['growth']::public.tenant_tier[],pg_temp.u178(1),'Synthetic178 quota grant',now()+interval'1 day'from generate_series(1,2)n;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current)
 values('onboarding-178',now(),'synthetic fixture','Not human catalogue approval',1,true);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('ONBOARD178','onboarding-178','Test','Test','GOV','low','[]','[]','[]','{}','{}','onboarding-178');
select public.designate_platform_founder(pg_temp.u178(2),'synthetic','Synthetic178 founder authority');
create function pg_temp.req178()returns jsonb language sql immutable as $$select jsonb_build_object('name','Synthetic178 organization','slug',null,'tier','growth','is_sdf',false,'processes_health_data',false,'processes_children_data',false,'dpo_name',null,'dpo_email',null,'systems','[]'::jsonb)$$;
create function pg_temp.hash178()returns text language sql stable as $$select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(pg_temp.req178()),'UTF8')),'hex')$$;
create function pg_temp.create178(a integer,k integer)returns jsonb language plpgsql as $$
declare raw text;request_text text;request_sha text;authority_sha text;claim jsonb;result jsonb;begin
 request_text:=controller_security.canonical_questionnaire_json(pg_temp.req178());
 raw:=controller_security.canonical_questionnaire_json(jsonb_build_object('operationKey',pg_temp.u178(k),'request',pg_temp.req178()));
 request_sha:=encode(sha256(convert_to('['||to_json(''::text)::text||','||to_json(raw)::text||']','UTF8')),'hex');
 authority_sha:=encode(sha256(convert_to('{"role":null,"scopes":[],"session":'||to_json(pg_temp.u178(100+a)::text)::text||'}','UTF8')),'hex');
 claim:=public.claim_request(pg_temp.u178(a),null,'/v1/organizations/onboard','POST',pg_temp.u178(k)::text,request_sha,authority_sha);
 if claim->>'decision'<>'claimed'then raise exception 'synthetic claim not admitted';end if;
 set local role human_action_writer;
 begin result:=public.onboard_organization_exact(pg_temp.u178(a),pg_temp.u178(100+a),pg_temp.u178(k),(claim->>'id')::uuid,request_sha,authority_sha,request_text,raw,'onboarding-178');
 exception when others then reset role;raise;end;
 reset role;return result;
end $$;
do $$declare r jsonb;readback jsonb;fenced jsonb;tenant uuid;engagement uuid;before_count integer;begin
 r:=pg_temp.create178(1,501);tenant:=(r->>'tenantId')::uuid;engagement:=(r->>'engagementId')::uuid;
 perform pg_temp.check178(r->>'state'='recorded','atomic exact receipt');
 perform pg_temp.check178((select role='owner'from public.tenant_users where tenant_id=tenant and user_id=pg_temp.u178(1)),'ordinary customer remains owner');
 perform pg_temp.check178((select role='founder'and membership_source='platform_founder'from public.tenant_users where tenant_id=tenant and user_id=pg_temp.u178(2)),'default live founder access');
 perform pg_temp.check178((select status='in_progress'from public.idempotency_keys where id=(select claim_id from controller_security.onboarding178_operations where actor_id=pg_temp.u178(1)and operation_key=pg_temp.u178(501))),'simulate response completion lost after committed creation');
 perform pg_temp.check178((select count(*)=1 from public.audit_ledger where tenant_id=tenant and correlation_id=pg_temp.u178(501)and id=(r->>'ledgerId')::bigint and entry_hash=r->>'ledgerSha256'),'exact original ledger reference');
 perform pg_temp.check178((select tenant_id=tenant and library_version='onboarding-178'from public.engagements where id=engagement),'exact initial assessment');
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.u178(101);
 readback:=public.read_onboarding_operation(pg_temp.u178(1),pg_temp.u178(201),pg_temp.u178(501),pg_temp.hash178());
 perform pg_temp.check178(readback=r,'new current session recovers original after original expires');
 perform pg_temp.check178(public.fence_onboarding_operation(pg_temp.u178(1),pg_temp.u178(201),pg_temp.u178(501),pg_temp.hash178())=r,'fence cannot undo committed tenant');
 begin perform public.read_onboarding_operation(pg_temp.u178(1),pg_temp.u178(201),pg_temp.u178(501),repeat('b',64));raise exception 'wrong hash accepted';exception when insufficient_privilege then null;end;
 readback:=public.read_onboarding_operation(pg_temp.u178(3),pg_temp.u178(103),pg_temp.u178(501),pg_temp.hash178());
 perform pg_temp.check178(readback->>'state'='unconfirmed'and not(readback?'tenantId'),'foreign actor cannot enumerate another receipt');
 delete from public.tenant_users where tenant_id=tenant and user_id=pg_temp.u178(1);
 readback:=public.read_onboarding_operation(pg_temp.u178(1),pg_temp.u178(201),pg_temp.u178(501),pg_temp.hash178());
 perform pg_temp.check178(readback->>'state'='recorded_access_withdrawn'and not(readback?'tenantId'),'offboarding withdraws entity visibility without inventing absence');
 select count(*)into before_count from public.tenants;
 fenced:=public.fence_onboarding_operation(pg_temp.u178(3),pg_temp.u178(103),pg_temp.u178(503),pg_temp.hash178());
 perform pg_temp.check178(fenced->>'state'='fenced'and(select count(*)=before_count from public.tenants),'fence consumes no tenant/quota');
 update auth.sessions set not_after=null where id=pg_temp.u178(101);
 fenced:=public.fence_onboarding_operation(pg_temp.u178(1),pg_temp.u178(201),pg_temp.u178(504),pg_temp.hash178());
 r:=pg_temp.create178(1,504);
 perform pg_temp.check178(r->>'state'='fenced','delayed create cannot pass prior exact barrier');
 r:=pg_temp.create178(2,502);
 perform pg_temp.check178(r->>'state'='recorded'and(select role='founder'and membership_source='platform_founder'from public.tenant_users where tenant_id=(r->>'tenantId')::uuid and user_id=pg_temp.u178(2)),'founder creator preserves derived report authority');
 begin update controller_security.onboarding178_operations set request_sha256=repeat('c',64);raise exception 'immutable receipt updated';exception when insufficient_privilege then null;end;
 -- Existing claim with no business receipt cannot be definitely fenced by
 -- asserting a semantic hash alone; transient exact original wire proof is required.
 r:=pg_temp.create178(4,505);
 perform pg_temp.check178(r->>'error'='onboarding_not_entitled','refused create consumes no entitlement');
 r:=public.fence_onboarding_operation(pg_temp.u178(4),pg_temp.u178(104),pg_temp.u178(505),pg_temp.hash178());
 perform pg_temp.check178(r->>'state'='unconfirmed','raw-vs-canonical original binding is not guessed');
 r:=public.fence_onboarding_operation(pg_temp.u178(4),pg_temp.u178(104),pg_temp.u178(505),pg_temp.hash178(),'{}');
 perform pg_temp.check178(r->>'state'='unconfirmed','wrong transient body cannot supply definite fence proof');
 r:=public.fence_onboarding_operation(pg_temp.u178(4),pg_temp.u178(104),pg_temp.u178(505),pg_temp.hash178(),controller_security.canonical_questionnaire_json(jsonb_build_object('operationKey',pg_temp.u178(505),'request',pg_temp.req178())));
 perform pg_temp.check178(r->>'state'='fenced','exact original wire body safely binds refused claim');
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.u178(104);
 begin perform public.read_onboarding_operation(pg_temp.u178(4),pg_temp.u178(104),pg_temp.u178(505),pg_temp.hash178());raise exception 'expired session accepted';exception when insufficient_privilege then null;end;
 perform pg_temp.check178(not has_table_privilege('human_action_writer','controller_security.onboarding178_operations','select')and not has_function_privilege('authenticated','public.read_onboarding_operation(uuid,uuid,uuid,text)','execute'),'narrow RPC only; no client table/grant expansion');
end $$;
rollback;
