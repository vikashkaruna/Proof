-- Prefix: tests/database/lib/postgresql-discovery-fixture.py. Everything is a
-- rolled-back disposable SQL demonstration, not a real Auth/operator approval.
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('owned166-test',clock_timestamp(),'fixture','Synthetic only',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.pg_id(20),pg_temp.pg_id(1),pg_temp.pg_id(3),'owned166-test','Owned boolean demonstration');
insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title) values(pg_temp.pg_id(54),pg_temp.pg_id(1),pg_temp.pg_id(20),'owned166-test','Synthetic audit logging setting');
insert into owned_synthetic.resources(fixture_id,resource_id) values(pg_temp.pg_id(50),pg_temp.pg_id(51));
insert into owned_synthetic.bindings(id,tenant_id,connector_id,engagement_id,fixture_id,resource_id,environment,label,scope,custody_policy_id,custody_activation_epoch,engine_sha256,capability_sha256,approval_reference,expires_at)
values(pg_temp.pg_id(52),pg_temp.pg_id(1),pg_temp.pg_id(6),pg_temp.pg_id(20),pg_temp.pg_id(50),pg_temp.pg_id(51),'test','Owned synthetic audit configuration','owned_synthetic_config.audit_log_enable','99143000-0000-4000-8000-000000000021',1,owned_synthetic.engine_sha256(),'a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9',pg_temp.pg_id(56),clock_timestamp()+interval '20 minutes');
-- Explicit administrative enrollment/JTI stand-ins for the strengthened169
-- fences, when present. No environment bypass, signing key or HTTP proof.
create temporary table fixture_owned169_claims(binding_id uuid primary key,claims jsonb);
do $setup169$declare binding uuid;begin
 if to_regprocedure('pg_temp.fixture_owned169_enrollment(uuid)') is not null then
  for binding in select id from owned_synthetic.bindings loop
   insert into fixture_owned169_claims values(binding,pg_temp.fixture_owned169_enrollment(binding));
  end loop;
 end if;
end $setup169$;
select set_config('request.jwt.claims',coalesce((select claims::text from fixture_owned169_claims where binding_id=pg_temp.pg_id(52)), '{}'),true);
create temporary table target166_saved(name text primary key,value jsonb);
grant select,insert on target166_saved to owned_target_controller;
create function pg_temp.target166_refused(statement text,code text default '42501') returns void language plpgsql as $$
begin
 begin execute statement;exception when others then if sqlstate=code then return;end if;raise;end;
 raise exception 'Owned target statement unexpectedly accepted';
end $$;
set local role owned_target_controller;
insert into target166_saved values('before',public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20)));
insert into target166_saved values('measurement',public.measure_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20)));
select pg_temp.ok((select value->>'persistent_mutations'='0' and value->>'resources_measured'='1' and value->'before'=(select value from target166_saved where name='before') and value#>>'{projected_after,audit_log_enabled}'='true' and value#>>'{restored,audit_log_enabled}'='false' from target166_saved where name='measurement'),'real no-write projection matches the existing ownedPostgres contract');
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name=''before''),true)');
select pg_temp.target166_refused('select public.read_owned_synthetic_target(pg_temp.pg_id(2),pg_temp.pg_id(52),pg_temp.pg_id(20))');
reset role;
select pg_temp.ok((select version=0 and not audit_log_enabled from owned_synthetic.resources),'measurement and refused unapproved write leave actual target unchanged');
insert into public.remediation_actions(id,tenant_id,plan_id,sequence,action_type,description,risk_score,parameters,blast_radius,rollback_definition)
select pg_temp.pg_id(53),pg_temp.pg_id(1),pg_temp.pg_id(54),1,'config.audit_log_enable','Only the owned synthetic boolean target',1,'{"enabled":true}','{"records":1}',jsonb_build_object('enabled',false,'snapshot_sha256',owned_synthetic.snapshot_sha256(value)) from target166_saved where name='before';
update owned_synthetic.bindings set action_id=pg_temp.pg_id(53) where id=pg_temp.pg_id(52);
select pg_temp.ok(public.record_dry_run(pg_temp.pg_id(1),pg_temp.pg_id(53),'succeeded',
 jsonb_build_object('changes',jsonb_build_array(jsonb_build_object('field','audit_log_enabled','before',false,'after',true)),
 'simulated_from','owned_fixture_persisted_snapshot','source_snapshot_sha256',(select owned_synthetic.snapshot_sha256(value) from target166_saved where name='before'),'records_measured',1),null,'sudhaar','{"enabled":true}',
 (select rollback_definition from public.remediation_actions where id=pg_temp.pg_id(53)),pg_temp.pg_id(58))?'dryRun','actual measured diff recorded through existing dry-run writer');
update public.remediation_actions set rollback_validated=true,rollback_validated_at=clock_timestamp() where id=pg_temp.pg_id(53);
-- Synthetic SQL setup mirrors accepted signed human approval/executor state.
-- The normal signer/MFA/claim HTTP paths are intentionally NOT exercised here.
insert into public.approval_tokens(id,tenant_id,plan_id,action_ids,approver_id,mode,signature,signed_payload,nonce,expires_at,status)
values(pg_temp.pg_id(55),pg_temp.pg_id(1),pg_temp.pg_id(54),array[pg_temp.pg_id(53)],'99143000-0000-4000-8000-000000000001','batch','synthetic-sql-fixture-signature',jsonb_build_object('contentDigest',public.action_set_content_digest(pg_temp.pg_id(1),pg_temp.pg_id(54),array[pg_temp.pg_id(53)])),'owned166-synthetic-nonce',clock_timestamp()+interval '10 minutes','consumed');
update public.remediation_actions set approval_status='approved',approval_token_id=pg_temp.pg_id(55),approved_by='99143000-0000-4000-8000-000000000001',execution_status='executing',execution_request_key='owned166-synthetic-request',dispatch_status='pending' where id=pg_temp.pg_id(53);
insert into target166_saved values('batch',public.start_execution_batch(pg_temp.pg_id(1),pg_temp.pg_id(54),'owned166-synthetic-request',pg_temp.pg_id(59),'owned166-synthetic-nonce',public.action_set_content_digest(pg_temp.pg_id(1),pg_temp.pg_id(54),array[pg_temp.pg_id(53)]),'batch',1,true,'owned166-synthetic-request',array[pg_temp.pg_id(53)]));
select pg_temp.ok(public.mark_execution_action_started(pg_temp.pg_id(1),pg_temp.pg_id(53),(select(value#>>'{batch,id}')::uuid from target166_saved where name='batch'),pg_temp.pg_id(59))?'ok','existing executor starts the exact approved action');
-- Scope/digest failures cannot perform the first write or create a journal.
do $$begin
 begin update public.approval_tokens set status='revoked' where id=pg_temp.pg_id(55);
 perform public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name='before'),true);
 raise exception 'revoked token accepted';exception when insufficient_privilege then if sqlerrm<>'owned target approval refused' then raise;end if;end;
 begin update public.execution_batches set content_digest=repeat('0',64) where id=(select(value#>>'{batch,id}')::uuid from target166_saved where name='batch');
 perform public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name='before'),true);
 raise exception 'wrong content digest accepted';exception when insufficient_privilege then if sqlerrm<>'owned target approval refused' then raise;end if;end;
end $$;
-- Expiry, declared radius, and the latest measured content remain fences.
do $$begin
 begin update public.approval_tokens set expires_at=clock_timestamp()-interval '1 second' where id=pg_temp.pg_id(55);
 perform public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name='before'),true);
 raise exception 'expired token accepted';exception when insufficient_privilege then if sqlerrm<>'owned target approval refused' then raise;end if;end;
 begin update public.dry_runs set expires_at=clock_timestamp()-interval '1 second' where id=(select latest_dry_run_id from public.remediation_actions where id=pg_temp.pg_id(53));
 perform public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name='before'),true);
 raise exception 'expired dry run accepted';exception when insufficient_privilege then if sqlerrm<>'owned target approval refused' then raise;end if;end;
end $$;
select pg_temp.ok((select count(*)=0 from owned_synthetic.operations),'all failed authority attempts leave no operation journal');
select pg_temp.ok((select version=0 and not audit_log_enabled from owned_synthetic.resources),'all failed authority attempts leave persisted source unchanged');
set local role owned_target_controller;
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name=''before''),false)');
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value||jsonb_build_object(''version'',99) from target166_saved where name=''before''),true)');
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value||jsonb_build_object(''arbitrary_sql'',''untrusted'') from target166_saved where name=''before''),true)','22023');
reset role;
set local role owned_target_controller;
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value||jsonb_build_object(''resource_id'',pg_temp.pg_id(99)) from target166_saved where name=''before''),true)');
insert into target166_saved values('after',public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name='before'),true));
select pg_temp.ok((select value->>'version'='1' and value->>'audit_log_enabled'='true' from target166_saved where name='after'),'approved boolean setting actually changed');
select pg_temp.ok(public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(57),(select value from target166_saved where name='before'),true)=(select value from target166_saved where name='after'),'identical original operation recovers without another write');
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(60),(select value from target166_saved where name=''before''),true)');
select pg_temp.ok(public.read_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20))=(select value from target166_saved where name='after'),'independent target read confirms exact post-state');
insert into target166_saved values('restored',public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(61),(select value from target166_saved where name='after'),false));
select pg_temp.ok((select value->>'version'='2' and value->>'audit_log_enabled'='false' from target166_saved where name='restored'),'stored original rollback restores content with newer version');
select pg_temp.ok(public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(61),(select value from target166_saved where name='after'),false)=(select value from target166_saved where name='restored'),'rollback exact replay does not change version again');
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(61),(select value from target166_saved where name=''after''),true)','22023');
select pg_temp.target166_refused('select public.cas_owned_synthetic_target(pg_temp.pg_id(1),pg_temp.pg_id(52),pg_temp.pg_id(20),pg_temp.pg_id(62),(select value from target166_saved where name=''after''),false)','40001');
reset role;
select pg_temp.target166_refused('update owned_synthetic.bindings set resource_id=pg_temp.pg_id(99) where id=pg_temp.pg_id(52)');
select pg_temp.target166_refused('update owned_synthetic.operations set kind=''rollback''');
select pg_temp.ok((select count(*)=2 from owned_synthetic.operations),'one journal per forward and rollback');
select pg_temp.ok((select count(*)=2 from public.audit_ledger where correlation_id in(pg_temp.pg_id(57),pg_temp.pg_id(61))),'each actual boolean transition has one append-only ledger receipt');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.pg_id(1))),'target writes preserve ledger chain');
select pg_temp.ok(not has_schema_privilege('owned_target_controller','owned_synthetic','USAGE'),'target RPC role has no direct schema access');
select pg_temp.ok(not has_table_privilege('owned_target_controller','public.approval_tokens','INSERT'),'target cannot mint human approval');
select pg_temp.ok(not has_function_privilege('service_role','public.cas_owned_synthetic_target(uuid,uuid,uuid,uuid,jsonb,boolean)','EXECUTE'),'broad backend role cannot directly mutate synthetic target');
select pg_temp.ok(not has_function_privilege('authenticated','public.cas_owned_synthetic_target(uuid,uuid,uuid,uuid,jsonb,boolean)','EXECUTE'),'browser cannot directly mutate synthetic target');
rollback;
