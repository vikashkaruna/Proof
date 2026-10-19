"""Generate synthetic owned SQL sourcegraph for the accounted process fixture.

Only prints fixture SQL; caller must create/destroy its own guarded database.
No retained identity, human approval, deployment or provider proof is implied.
"""
from pathlib import Path
import json
import re

ROOT=Path(__file__).resolve().parents[2]
source=(ROOT/'tests/database/prativedan-assessment-drafts.test.sql').read_text()
source=source.split('-- P123_CONCURRENCY_FIXTURE_END: reviewed request, no claim.')[0]
source=source.replace('begin;','begin;\ncreate schema p172_fixture;\ngrant usage on schema p172_fixture to human_action_writer,axiom_prativedan_controller;',1)
source=source.replace('pg_temp.','p172_fixture.').replace('create temporary table','create table')
for name in ['issued','p123_context']:
    source=re.sub(r'\b'+name+r'\b','p172_fixture.'+name,source)
print(source)
print("create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);")
print("insert into auth.sessions(id,user_id,not_after) values(p172_fixture.id(95),p172_fixture.id(1),null);commit;")
signatures={
'preview_prativedan_assessment_source':dict(t='uuid',a='uuid',e='uuid',r='uuid'),
'request_prativedan_assessment_draft':dict(t='uuid',a='uuid',human_text='text'),
'read_prativedan_assessment_draft':dict(t='uuid',a='uuid',human_text='text'),
'review_prativedan_assessment_draft':dict(t='uuid',a='uuid',k='uuid',review_key='uuid',expected_hash='text',decision='text',reason='text'),
'read_prativedan_accounted_registration':dict(t='uuid',subject='text'),
'read_prativedan_accounted_context':dict(t='uuid',k='uuid',r='uuid',rh='text',authority='jsonb'),
'load_prativedan_assessment_dispatch':dict(t='uuid',k='uuid',r='uuid',rh='text',authority='jsonb'),
'start_prativedan_accounted_draft':dict(t='uuid',k='uuid',r='uuid',rh='text',input_text='text',task_sha256='text',authority='jsonb'),
'finish_prativedan_accounted_draft':dict(t='uuid',k='uuid',r='uuid',rh='text',task_proof='text',output_text='text',failure_code='text',latency_ms='integer',authority='jsonb'),
'read_prativedan_accounted_draft':dict(t='uuid',k='uuid',r='uuid',rh='text',authority='jsonb'),
'prativedan_read_model_accounting_result':dict(t='uuid',r='uuid',rh='text',k='uuid',authority='jsonb'),
'read_prativedan_assessment_runtime_receipts':dict(t='uuid',k='uuid',r='uuid',rh='text',started='bigint',completed='bigint',authority='jsonb'),
'settle_prativedan_assessment_draft':dict(t='uuid',k='uuid',r='uuid',rh='text',input_hash='text',config_text='text',output_text='text',response_text='text',started='bigint',completed='bigint',authority='jsonb'),
}
# Values are public SQL types and fixed function identifiers, never credentials.
manifest=json.dumps(signatures).replace("'","''")
print("""create function p172_fixture.rpc(name text,args jsonb) returns jsonb language plpgsql set search_path='' as $$
declare signatures jsonb := '"""+manifest+"""'::jsonb; sig jsonb; field record; expressions text[]; value jsonb;
begin
 sig:=signatures->name;
 if sig is null or jsonb_typeof(args)<>'object' or (select count(*) from jsonb_object_keys(args))<>(select count(*) from jsonb_object_keys(sig))
 then raise exception 'fixture fixed rpc refused' using errcode='42501';end if;
 for field in select item.key,item.value#>>'{}' as type from jsonb_each(sig) item order by item.key loop
  if not(args ? field.key) then raise exception 'fixture argument refused' using errcode='42501';end if;
  expressions:=array_append(expressions,format('%I => ($1%s%L)::%s',field.key,case when field.type='jsonb' then '->' else '->>' end,field.key,field.type));
 end loop;
 execute format('select public.%I(%s)',name,array_to_string(expressions,',')) into value using args;
 set constraints all immediate;
 return value;
exception when others then return jsonb_build_object('fixture_error',sqlstate);
end $$;
grant execute on function p172_fixture.rpc(text,jsonb) to human_action_writer,axiom_prativedan_controller;
""")
