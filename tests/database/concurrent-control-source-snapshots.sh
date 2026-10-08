#!/usr/bin/env bash
# Actual stale snapshots must never overpopulate or publish an obsolete source.
set -euo pipefail
container="$1"
database="${2:-axiom_policy_test}"
python3 - "$container" "$database" <<'PY'
import subprocess,sys,time
container,database=sys.argv[1:]
command=['docker','exec','-i',container,'psql','-X','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-Atq']
def sql(query,check=True):
    result=subprocess.run(command,input=query,text=True,capture_output=True)
    if check and result.returncode:raise RuntimeError(result.stderr)
    return result
def start(query):
    p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    p.stdin.write(query);p.stdin.close();p.stdin=None
    return p
def barrier(marker):
    for _ in range(100):
        if sql(f"select count(*) from pg_locks where locktype='advisory' and objid={marker} and granted").stdout.strip()=='1':return
        time.sleep(.05)
    raise AssertionError('Actual old snapshot barrier was not reached')
def insert(version,id):
    return f"insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version) values('{id}','{version}','Fixture','Fixture','SEC','low','[]','[]','[]','{{\"baseline\":0,\"weight\":1,\"penaltyPoints\":10,\"maxPenaltyINR\":1000000}}','{{}}','{version}');"
for n,isolation in enumerate(['repeatable read','serializable']):
    for k,(scenario,initial,mutation) in enumerate([('population',1,'insert'),('publication-extra',2,'insert'),('publication-missing',2,'delete')]):
        status='published' if initial==1 else 'draft'
        version=f'control-snapshot-{scenario}-{n}'
        sql(f"insert into public.control_libraries(version,published_at,published_by,change_log,control_count,status) values('{version}',now(),'test','Independent stale snapshot fixture',2,'{status}');"+''.join(insert(version,'INITIAL-'+str(i)) for i in range(initial)))
        marker=116300+n*10+k
        final=insert(version,'STALE-EXTRA') if initial==1 else f"update public.control_libraries set status='published' where version='{version}';"
        old=start(f"begin isolation level {isolation};select count(*) from public.controls where library_version='{version}';select pg_advisory_lock({marker});select pg_sleep(2);{final}commit;")
        barrier(marker)
        sql(insert(version,'OTHER-COMMITTED') if mutation=='insert' else f"delete from public.controls where library_version='{version}' and id='INITIAL-0';")
        out,err=old.communicate(timeout=10)
        assert old.returncode!=0 and '40001' in err,(isolation,scenario,out,err)
        count=sql(f"select count(*) from public.controls where library_version='{version}'").stdout.strip()
        actual=sql(f"select status from public.control_libraries where version='{version}'").stdout.strip()
        assert count==('2' if initial==1 else ('3' if mutation=='insert' else '1')) and actual==status,(isolation,scenario,count,actual)
        retry=sql(final,check=False)
        assert retry.returncode!=0 and '42501' in retry.stderr,(isolation,scenario,retry.stdout,retry.stderr)
        print(f'{isolation}: stale {scenario} refused with 40001; fresh retry refuses invalid source with 42501; committed state preserved.')
    normal=f'control-snapshot-normal-{n}'
    sql(f"begin isolation level {isolation};insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('{normal}',now(),'test','Normal snapshot population',2);"+insert(normal,'NORMAL-1')+insert(normal,'NORMAL-2')+'commit;')
    assert sql(f"select count(*) from public.controls where library_version='{normal}'").stdout.strip()=='2'
    print(f'{isolation}: ordinary complete population succeeds without an isolation prohibition.')
PY
