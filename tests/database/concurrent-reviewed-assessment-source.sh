#!/usr/bin/env bash
# Independent sessions prove source pins and initial publication cannot race.
set -euo pipefail
container="$1"
database="${2:-axiom_policy_test}"
python3 - "$container" "$database" <<'PY'
import subprocess, sys, time
container, database = sys.argv[1:]
def sql(query, check=True):
    result=subprocess.run(['docker','exec','-i',container,'psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-Atq'],input=query,text=True,capture_output=True)
    if check and result.returncode: raise RuntimeError(result.stderr)
    return result
def launch(query):
    process=subprocess.Popen(['docker','exec','-i',container,'psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-Atq'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    process.stdin.write(query);process.stdin.close();process.stdin=None
    return process
def await_lock(marker):
    for _ in range(100):
        if sql(f"select count(*) from pg_locks where locktype='advisory' and objid={marker} and granted").stdout.strip()=='1': return
        time.sleep(.05)
    raise AssertionError('Source race barrier not acquired')
# A one-control published version retains initial seed compatibility, but two
# independent inserts cannot exceed its fixed published count.
version='reviewed-concurrent-population'
sql(f"insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('{version}',now(),'test','race fixture',1)")
def insert(identifier):
    return f"insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version) values('{identifier}','{version}','Fixture','Fixture','SEC','low','[]','[]','[]','{{\"baseline\":0,\"weight\":1,\"penaltyPoints\":10,\"maxPenaltyINR\":1000000}}','{{}}','{version}');"
first=launch('begin;'+insert('FIRST')+'select pg_advisory_lock(114114);select pg_sleep(2);commit;')
await_lock(114114)
second=launch(insert('SECOND'))
time.sleep(.15)
assert second.poll() is None, 'Competing insert must wait for the published library lock'
out,err=first.communicate(timeout=10)
assert first.returncode==0,err
out,err=second.communicate(timeout=10)
assert second.returncode!=0 and 'Published control sources' in err, (out,err)
assert sql(f"select count(*) from public.controls where library_version='{version}'").stdout.strip()=='1'
# Guarded enqueue must block on a concurrent engagement pin update, then reject
# the committed new pin before issuing an outbox/task or human receipt.
fixture=open('tests/database/reviewed-assessment-source.test.sql').read()
fixture=fixture[:fixture.index('select pg_temp.ok(encode')]
fixture=fixture.replace('begin;','',1).replace('79790000','80800000').replace('reviewed-source-fixture','reviewed-race-fixture')
sql(fixture+"insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('reviewed-race-other',now(),'test','fixture',2);")
# Temporary helpers do not survive sessions, so the guarded request is explicit.
uid=lambda n:f"80800000-0000-4000-8000-{n:012d}"
holder=launch(f"begin;update public.engagements set library_version='reviewed-race-other' where id='{uid(21)}';select pg_advisory_lock(114115);select pg_sleep(2);commit;")
await_lock(114115)
request=f"set role human_action_writer;select public.enqueue_reviewed_assessment_dispatch('{uid(51)}','{uid(11)}','{uid(1)}','{uid(31)}','{uid(22)}','{uid(21)}','{uid(41)}',repeat('a',64),repeat('b',64),now()+interval '5 minutes','fixture',decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),1,repeat('c',64),'reviewed-race-fixture-v1',repeat('d',64))->>'error';"
blocked=launch(request)
time.sleep(.15)
assert blocked.poll() is None, 'Guarded enqueue must wait for current pin row lock'
out,err=holder.communicate(timeout=10)
assert holder.returncode==0,err
out,err=blocked.communicate(timeout=10)
assert blocked.returncode==0 and out.strip()=='questionnaire_source_changed',(out,err)
assert sql(f"select count(*) from public.assessment_dispatch_jobs where tenant_id='{uid(11)}'").stdout.strip()=='0'
print('Reviewed source races: competing initial population serialized; changed engagement pin refused; no dispatch created.')
PY
