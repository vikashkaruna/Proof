begin;
create function pg_temp.check_result(actual text, expected text) returns void language plpgsql as $$
begin if actual is distinct from expected then raise exception 'Expected %, got %',expected,actual; end if; end $$;
insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000051','idem@test.invalid');
set local role service_role;
do $$
declare r jsonb; claim_id uuid;
begin
  r := public.claim_request('00000000-0000-0000-0000-000000000051',null,'/onboard','POST','test-key-1',repeat('a',64),repeat('b',64));
  perform pg_temp.check_result(r->>'decision','claimed');
  claim_id := (r->>'id')::uuid;
  r := public.claim_request('00000000-0000-0000-0000-000000000051',null,'/onboard','POST','test-key-1',repeat('a',64),repeat('b',64));
  perform pg_temp.check_result(r->>'decision','in_progress');
  r := public.claim_request('00000000-0000-0000-0000-000000000051',null,'/onboard','POST','test-key-1',repeat('c',64),repeat('b',64));
  perform pg_temp.check_result(r->>'decision','conflict');
  r := public.claim_request('00000000-0000-0000-0000-000000000051',null,'/onboard','POST','test-key-1',repeat('a',64),repeat('c',64));
  perform pg_temp.check_result(r->>'decision','conflict');
  if not public.complete_request(claim_id,repeat('a',64),201,'{"created":true}') then raise exception 'completion failed'; end if;
  if public.complete_request(claim_id,repeat('a',64),200,'{"created":false}') then raise exception 'completion was overwritten'; end if;
  r := public.claim_request('00000000-0000-0000-0000-000000000051',null,'/onboard','POST','test-key-1',repeat('a',64),repeat('b',64));
  perform pg_temp.check_result(r->>'decision','replay');
  perform pg_temp.check_result(r->>'status','201');
  perform pg_temp.check_result(r->'body'->>'created','true');
  update public.idempotency_keys set replay_until=now()-interval '1 hour' where id=claim_id;
  r := public.claim_request('00000000-0000-0000-0000-000000000051',null,'/onboard','POST','test-key-1',repeat('a',64),repeat('b',64));
  perform pg_temp.check_result(r->>'decision','expired');
end $$;
reset role;
do $$ begin
  if has_function_privilege('authenticated','public.claim_request(uuid,uuid,text,text,text,text,text)','EXECUTE') then
    raise exception 'client can forge claims';
  end if;
end $$;
rollback;
