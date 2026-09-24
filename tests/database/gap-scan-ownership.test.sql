begin;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m;end if;end $$;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('gap-test',now(),'test','fixture',0);
set local role service_role;
insert into public.gap_scan_responses(id,session_id,access_token_hash,library_version,report_snapshot)
values('00000000-0000-4000-8000-000000000077','analytics',repeat('a',64),'gap-test','{"persisted":true}');
select pg_temp.assert_true((select count(*)=1 from public.gap_scan_responses where id='00000000-0000-4000-8000-000000000077'),'service can persist without BYPASSRLS');
reset role;
set local role anon;
select pg_temp.assert_true(not has_table_privilege(current_user,'public.gap_scan_responses','INSERT'),'anonymous cannot forge snapshots or ownership');
select pg_temp.assert_true(not has_table_privilege(current_user,'public.gap_scan_responses','UPDATE'),'anonymous cannot replace ownership');
do $$ begin
  if exists(select 1 from public.gap_scan_responses) then raise exception 'anonymous read report data'; end if;
exception when insufficient_privilege then null; end $$;
reset role;
set local role authenticated;
select pg_temp.assert_true(not has_table_privilege(current_user,'public.gap_scan_responses','INSERT'),'authenticated cannot forge snapshots');
select pg_temp.assert_true(not has_table_privilege(current_user,'public.gap_scan_responses','UPDATE'),'authenticated cannot replace ownership');
select pg_temp.assert_true(not has_table_privilege(current_user,'public.gap_scan_responses','DELETE'),'authenticated cannot delete reports');
reset role;
rollback;
