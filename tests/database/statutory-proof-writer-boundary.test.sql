-- A generic worker service key cannot impersonate a founder or invent a
-- provider receipt. The distinct PostgREST writer role can execute the BFF
-- mutation contract; the function still enforces ordinary business guards.
begin;
create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'ASSERTION FAILED: shared service role executed %', statement;
end $$;

insert into auth.users(id,email) values
 ('99890100-0000-4000-8000-000000000001','writer-founder@example.invalid');
insert into public.users(id,email,full_name,is_axiom_internal) values
 ('99890100-0000-4000-8000-000000000001','writer-founder@example.invalid','Founder',true);
insert into public.tenants(id,slug,name) values
 ('99890100-0000-4000-8000-000000000010','writer-boundary-test','Writer Boundary Test');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000001','founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('writer-boundary-lib',now(),'fixture','synthetic',0);
insert into public.reports(id,tenant_id,kind,title,content,library_version,generated_by_agent,status,content_text,content_sha256) values
 ('99890100-0000-4000-8000-000000000020','99890100-0000-4000-8000-000000000010',
  'board','Writer boundary fixture','{}','writer-boundary-lib','board-report-builder','draft','{}',
  encode(sha256(convert_to('{}','UTF8')),'hex'));

select pg_temp.ok(not (select rolinherit or rolcanlogin or rolbypassrls from pg_roles where rolname='statutory_proof_writer'),
 'writer role has no login, inheritance or RLS bypass');
select pg_temp.ok(pg_has_role('authenticator','statutory_proof_writer','member'),
 'PostgREST authenticator may assume restricted role');
select pg_temp.ok(not pg_has_role('service_role','statutory_proof_writer','member'),
 'shared service role cannot assume proof writer');

set local role service_role;
select pg_temp.denied($s$select public.review_report(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000020',
 'approved',null,'99890100-0000-4000-8000-000000000001',repeat('a',64),gen_random_uuid())$s$);
select pg_temp.denied($s$select public.settle_source_bound_pramaan(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000001',
 gen_random_uuid(),'{"verified":true,"content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb,
 gen_random_uuid())$s$);
select pg_temp.denied($s$select public.release_report(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000020',
 '99890100-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),gen_random_uuid())$s$);
select pg_temp.denied($s$select public.begin_evidence_pack_build(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000001',
 gen_random_uuid(),gen_random_uuid(),'{}'::jsonb,gen_random_uuid())$s$);
select pg_temp.denied($s$select public.record_report_draft(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000001',
 gen_random_uuid(),'board','Forged draft',null,'writer-boundary-lib','{}','agent',gen_random_uuid())$s$);
select pg_temp.denied($s$insert into public.statutory_report_artifacts(
 tenant_id,report_id,kind,source_json_sha256,source_json_bytes,html_sha256,html_bytes)
 values('99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000020',
 'board',repeat('a',64),1,repeat('b',64),1)$s$);
reset role;

set local role statutory_proof_writer;
select pg_temp.ok(public.review_report(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000020',
 'approved',null,'99890100-0000-4000-8000-000000000001',
 encode(sha256(convert_to('{}','UTF8')),'hex'),gen_random_uuid())->>'status'='approved',
 'restricted writer executes real founder review');
select pg_temp.ok(public.seal_source_bound_pramaan(
 '99890100-0000-4000-8000-000000000010','99890100-0000-4000-8000-000000000001',
 gen_random_uuid(),repeat('a',64),gen_random_uuid())->>'error'='source_bound_dossier_required',
 'restricted writer can invoke dossier mutation, which still enforces source existence');
reset role;
rollback;
