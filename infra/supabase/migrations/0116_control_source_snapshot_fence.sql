-- A row lock alone does not refresh a REPEATABLE READ snapshot. Every control
-- INSERT/DELETE must create an actual MVCC version of its catalog row. A stale
-- source writer or draft publisher then fails with PostgreSQL serialization
-- error 40001 rather than validating an obsolete control count. This works at
-- READ COMMITTED, REPEATABLE READ and SERIALIZABLE without forbidding isolation.
-- The version value remains unchanged; no source content/authority is altered.
create or replace function controller_security.protect_published_control_source()
returns trigger language plpgsql security definer set search_path='' as $$
declare library public.control_libraries; source_version text;
begin
 if tg_op='TRUNCATE' then raise exception 'Control source truncation refused' using errcode='42501'; end if;
 source_version:=case when tg_op='DELETE' then old.library_version else new.library_version end;
 update public.control_libraries as catalog set version=catalog.version
  where catalog.version=source_version returning catalog.* into library;
 if library.status in ('published','deprecated') then
  if tg_op='DELETE' or ((select count(*) from public.controls where library_version=source_version)>=library.control_count
    and not exists(select 1 from public.controls where library_version=source_version and id=new.id))
  then raise exception 'Published control sources are append-only across versions' using errcode='42501'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function controller_security.protect_published_control_source()
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
