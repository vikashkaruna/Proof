-- Same connection preserves before-upgrade expected bytes in session TEMP tables.
begin;
do $$declare x record;r jsonb;after_row jsonb;report public.reports;
begin
 for x in select * from coverage144_old_expected loop
  if x.kind='board' then
   select to_jsonb(q) into after_row from public.board_report_requests q where q.id=(x.request_row->>'id')::uuid;
  else select to_jsonb(q) into after_row from public.statutory_report_requests q where q.id=(x.request_row->>'id')::uuid;end if;
  perform pg_temp.ok(after_row=x.request_row,'upgrade preserves genuine old pending request exact row');
  perform pg_temp.ok(case x.kind when 'board' then (select source_text=x.source_text and source_sha256=x.source_sha256 from public.board_request_sources where request_id=(x.request_row->>'id')::uuid)
   else (select source_text=x.source_text and source_sha256=x.source_sha256 from public.statutory_request_sources where request_id=(x.request_row->>'id')::uuid) end,'upgrade preserves exact old source text/hash');
  perform pg_temp.ok(pg_temp.document(x.kind)=x.document,'legacy document generation unchanged after144');
  if x.kind='board' then
   r:=public.request_board_report(pg_temp.id(31),pg_temp.id(1),pg_temp.id(301),pg_temp.id(41),((select value from issued)->>'run_id')::uuid,x.request_row->>'title',pg_temp.id(302));
  else
   r:=public.request_statutory_report(pg_temp.id(31),pg_temp.id(1),pg_temp.id(303),pg_temp.id(41),((select value from issued)->>'run_id')::uuid,'auditor',x.request_row->>'title',pg_temp.id(304));end if;
  perform pg_temp.ok(r->>'replayed'='true','old exact request replays without policy upgrade');
  r:=pg_temp.draft(x.kind,x.document);
  perform pg_temp.ok(r?'reportId','old pending source2/3 generates old document3/4 after144');
  select * into report from public.reports where id=(r->>'reportId')::uuid;
  perform pg_temp.ok(report.content=x.document and report.content_sha256=encode(sha256(convert_to(x.document::text,'UTF8')),'hex'),'old document text-derived digest remains exact');
  perform pg_temp.ok(pg_temp.draft(x.kind,x.document)->>'replayed'='true','old exact draft replay unchanged');
  perform pg_temp.ok(case x.kind when 'board' then (select source_text=x.source_text and source_sha256=x.source_sha256 from public.board_request_sources where request_id=(x.request_row->>'id')::uuid)
   else (select source_text=x.source_text and source_sha256=x.source_sha256 from public.statutory_request_sources where request_id=(x.request_row->>'id')::uuid) end,'old source remains unchanged after replay/generation');
 end loop;
end $$;
commit;

-- Exact pre-upgrade143 history rows remain untouched; only144 is appended.
select pg_temp.ok((select count(*)=143 from coverage144_history_before),'143 genuine prior migration rows');
select pg_temp.ok(not exists(select 1 from coverage144_history_before b where not exists(
 select 1 from axiom_migrations.applied a where to_jsonb(a)=b.value)),'all143 historical migration rows exact');
select pg_temp.ok((select count(*)=144 from axiom_migrations.applied),'144 added once');
select pg_temp.ok((select count(*)=0 from public.tenants t cross join lateral public.verify_ledger(t.id)),'historical upgrade ledger chain intact');
