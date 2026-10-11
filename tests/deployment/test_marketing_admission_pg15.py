"""Opt-in real PG15 TLS tests, restricted to the recorded new rehearsal fixture.

No cloud calls. The GCS adapter is a fake: these tests prove the database
admission boundary, not provider deployment or named workflow acceptance.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import pytest

ROOT=Path(__file__).resolve().parents[2]
FIXTURE_ID='8ab959c224db35de0bd28386794d19fb59d94b7e3e801141a96d8fcd4c21e117'
IMAGE_ID='sha256:d4a8e1f88f475ee3e0137fa89d21ebc59f6c6ab16bf369ee92907607cc3455ae'
VOLUME='ccdbce2e99de9273a249369586e853a919393f17acf4774c3264b1724ee874cc'
pytestmark=pytest.mark.skipif(os.getenv('AXIOM_ADMISSION_PG15_FIXTURE_ID')!=FIXTURE_ID,
                            reason='Exact isolated PG15 rehearsal fixture explicitly required')
spec=importlib.util.spec_from_file_location('admission_native_inputs',ROOT/'tests/deployment/test_marketing_admission_gate.py')
inputs_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(inputs_module)
gate=inputs_module.gate

def guard():
    data=json.loads(subprocess.run(['docker','inspect',FIXTURE_ID],capture_output=True,text=True,check=True,timeout=10).stdout)[0]
    assert data['Id']==FIXTURE_ID and data['Image']==IMAGE_ID
    assert data['Name']=='/axiom-preprod-admission-pg15-20261010'
    assert data['Config']['Labels'].get('axiom.scope')=='marketing-admission-pg15-rehearsal'
    assert data['HostConfig']['NetworkMode']=='none' and not data['HostConfig']['PortBindings']
    assert not data['HostConfig']['Binds'] and len(data['Mounts'])==1
    mount=data['Mounts'][0]
    assert mount['Type']=='volume' and mount['Name']==VOLUME and mount['Destination']=='/var/lib/postgresql/data'
    users=subprocess.run(['docker','ps','-a','--filter','volume='+VOLUME,'--format','{{.ID}}'],capture_output=True,text=True,check=True,timeout=10).stdout.splitlines()
    assert users==[FIXTURE_ID[:12]]

def spawn(argv,**kwargs):
    guard()
    environment=kwargs.pop('env')
    command=['docker','exec','-i']
    for key,value in environment.items():
        if key.startswith('PG'):command+=['-e',key+'='+value]
    command += [FIXTURE_ID,*argv]
    return subprocess.Popen(command,**kwargs)

def session(database='postgres',options=''):
    env={'PGHOST':'127.0.0.1','PGUSER':'postgres','PGDATABASE':database,'PGSSLMODE':'require'}
    # Production always chooses maintenance postgres; direct native delayed
    # target backend is used separately for startup-race observation.
    return gate.MaintenanceSession(env,spawn=spawn)

def direct(database,sql,options=''):
    env={'PGHOST':'127.0.0.1','PGUSER':'postgres','PGDATABASE':database,'PGSSLMODE':'require','PGOPTIONS':options}
    proc=spawn(['psql','-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1'],env=env,
               stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    proc.stdin.write(sql);proc.stdin.close();proc.stdin=None
    return proc

def setup_database(name):
    guard()
    proc=direct('postgres','create database '+name+';\n')
    stdout,stderr=proc.communicate(timeout=15)
    assert proc.returncode==0, 'Fresh database creation refused; preserve fixture'
    source,binding=inputs_module.inputs()
    source['CLOUD_SQL_ADMIN_USER']='postgres';source['CLOUD_SQL_DATABASE_NAME']=name
    binding['database_name']=name
    return source,binding

def programs(name):
    spec=importlib.util.spec_from_file_location('native_admission_sql',ROOT/'scripts/marketing-db-job.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.admission_programs(name)

def test_native_pg15_tls_zero_clients_fenced_seed_and_same_pid_reopen():
    name='axiom_proof_preprod_native_v2_success';source,binding=setup_database(name)
    maintenance=session();events=[]
    try:
        receipt=gate.fenced_seed(source,binding,maintenance,inputs_module.Cloud(),lambda stage,value:events.append(stage))
        after=maintenance.query(programs(name)['identity'])
        assert receipt['native_pid']==after['pid'] and after['allow_connections'] is True
        assert after['encrypted_transport'] is True and 150000<=int(after['server_version_num'])<160000
        assert 'closed' in events and 'ready_before_reopen' in events and events[-1]=='reopened'
    finally:maintenance.close()

def test_native_hidden_startup_lock_is_observed_before_visible_client_and_refuses():
    name='axiom_proof_preprod_native_v2_startup';source,binding=setup_database(name)
    maintenance=session();sql=programs(name);events=[]
    # PG15 applies post_auth_delay after admission check while the startup
    # RowExclusiveLock is held, before pgstat_bestart publishes activity.
    startup=direct(name,'select pg_sleep(2);\n','-c post_auth_delay=5')
    try:
        deadline=time.monotonic()+3
        while True:
            locks=maintenance.query(sql['startup_locks'])
            clients=maintenance.query(sql['clients'])
            if locks['startup_locks']>0:
                assert clients['clients']==[]
                break
            assert time.monotonic()<deadline, 'Native hidden startup was not deterministically observed'
            time.sleep(.05)
        cloud=inputs_module.Cloud()
        with pytest.raises(ValueError,match='drain timed out'):
            gate.fenced_seed(source,binding,maintenance,cloud,lambda stage,value:events.append(stage))
        assert maintenance.query(sql['identity'])['allow_connections'] is False
        assert 'seed' not in cloud.calls and 'reopened' not in events
        # Accepted pre-fence startup is allowed to finish naturally; never killed.
        stdout,stderr=startup.communicate(timeout=12)
        assert startup.returncode==0
        late=direct(name,'select 1;\n');out,err=late.communicate(timeout=10)
        assert late.returncode!=0 and 'not currently accepting connections' in err
        assert maintenance.query(sql['identity'])['allow_connections'] is False
    finally:maintenance.close()

def test_native_existing_auth_like_client_refusal_never_terminates_session():
    name='axiom_proof_preprod_native_v2_existing';source,binding=setup_database(name)
    maintenance=session();sql=programs(name)
    existing=direct(name,'select pg_sleep(4);\n')
    try:
        deadline=time.monotonic()+3
        while not maintenance.query(sql['clients'])['clients']:
            assert time.monotonic()<deadline
            time.sleep(.05)
        cloud=inputs_module.Cloud()
        with pytest.raises(ValueError):gate.fenced_seed(source,binding,maintenance,cloud,lambda stage,value:None)
        assert maintenance.query(sql['identity'])['allow_connections'] is False and 'seed' not in cloud.calls
        out,err=existing.communicate(timeout=10)
        assert existing.returncode==0, 'Existing client must finish naturally'
        assert maintenance.query(sql['identity'])['allow_connections'] is False
    finally:maintenance.close()

def test_native_auth_role_natural_drain_completes_then_reopens_without_termination():
    name='axiom_proof_preprod_native_v3_drain';source,binding=setup_database(name)
    binding['drain_seconds']=10
    maintenance=session();sql=programs(name);events=[]
    create=direct('postgres','create role admission_auth_v3 login nosuperuser noinherit nobypassrls;\n')
    out,err=create.communicate(timeout=10)
    assert create.returncode==0
    env={'PGHOST':'127.0.0.1','PGUSER':'admission_auth_v3','PGDATABASE':name,'PGSSLMODE':'require'}
    existing=spawn(['psql','-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1'],env=env,
                   stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    existing.stdin.write('select pg_sleep(2);\n');existing.stdin.close();existing.stdin=None
    try:
        deadline=time.monotonic()+3
        before=maintenance.query(sql['clients'])
        while not before['clients']:
            assert time.monotonic()<deadline
            time.sleep(.05);before=maintenance.query(sql['clients'])
        assert before['maintenance_clients']==0 and before['clients'][0]['role']=='admission_auth_v3'
        result=gate.fenced_seed(source,binding,maintenance,inputs_module.Cloud(),lambda stage,value:events.append({'stage':stage,**value}))
        out,err=existing.communicate(timeout=5)
        assert existing.returncode==0 and result['admission_reopened'] is True
        after=maintenance.query(sql['identity'])
        assert after['allow_connections'] is True and after['pid']==result['native_pid']
        path=ROOT/'.axiom-runtime/review/marketing-pg15-admission-20261010/native-v3-auth-drain-proof.private.json'
        descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'w') as fd:
            json.dump({'before':before,'events':events,'after':after,'client_finished_naturally':True},fd,sort_keys=True)
    finally:maintenance.close()
