"""Causal admission failures; mocked transport cannot establish live acceptance."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('admission_gate',ROOT/'scripts/marketing-state-adoption.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)

def inputs():
    source={'ENVIRONMENT':'preprod','GCP_REGION':'asia-south1','GCP_PROJECT_ID':'test-project',
            'MARKETING_MIGRATION_SERVICE_ACCOUNT':'axiom-proof-preprod-migrations@test-project.iam.gserviceaccount.com',
            'AXIOM_RELEASE_SHA':'a'*40,'CLOUD_SQL_INSTANCE_NAME':'axiom-proof-preprod-postgres',
            'CLOUD_SQL_DATABASE_NAME':'axiom_proof_preprod','CLOUD_SQL_ADMIN_USER':'axiom_admin',
            'MARKETING_MIGRATION_JOB_NAME':'axiom-proof-preprod-migrations-adopt',
            'MARKETING_AUTH_SERVICE_NAME':'axiom-proof-preprod-auth',
            'MARKETING_LIFECYCLE_SCHEDULER_NAME':'axiom-proof-preprod-idle',
            'AXIOM_IDLE_STATE_BUCKET':'axiom-proof-preprod-state'}
    target={'environment':'preprod','project':'test-project','instance':source['CLOUD_SQL_INSTANCE_NAME'],
            'bucket':source['AXIOM_IDLE_STATE_BUCKET'],'object':'marketing-preprod/lifecycle/state.json'}
    binding={'release_sha':'a'*40,'project':'test-project','database_connection_name':'test-project:asia-south1:axiom-proof-preprod-postgres',
             'database_name':'axiom_proof_preprod','target':target,
             'target_manifest_sha256':hashlib.sha256(gate.canonical_bytes(target)).hexdigest(),
             'auth_service':source['MARKETING_AUTH_SERVICE_NAME'],'scheduler_job':source['MARKETING_LIFECYCLE_SCHEDULER_NAME'],
             'drain_seconds':0,'seed_created_unix':1800000000}
    binding['seed_body_sha256']=hashlib.sha256(gate.canonical_bytes({'version':1,'targetHash':binding['target_manifest_sha256'],
         'phase':'running','lastActivity':1800000000,'leases':{},'transition':None,'operation':None})).hexdigest()
    base={k:binding[k] for k in ('release_sha','project','database_connection_name')}
    binding['bootstrap_receipts']={phase:{**base,'phase':phase,'job':f'projects/test-project/locations/asia-south1/jobs/axiom-proof-preprod-migrations-{phase}',
        'execution':f'projects/test-project/locations/asia-south1/jobs/axiom-proof-preprod-migrations-{phase}/executions/axiom-proof-preprod-execution','completion_time':'2026-10-10T00:00:00Z','descriptor_sha256':'b'*64}
        for phase in ('roles','series')}
    binding['bootstrap_receipts']['auth']={**base,'service':binding['auth_service'],'service_ready':True}
    return source,binding

class Session:
    def __init__(self):
        self.allow=True;self.calls=[];self.mutate=None;self.locks=0;self.clients=[];self.workers=[];self.prepared=0;self.other_admin=0
    def query(self,sql):
        self.calls.append(sql)
        if 'startup_locks' in sql:
            row={'pid':123,'startup_locks':self.locks}
        elif "'clients'" in sql:
            row={'pid':123,'clients':self.clients,'unknown_workers':self.workers,
                 'prepared_transactions':self.prepared,'maintenance_clients':self.other_admin}
        else:
            if 'allow_connections false' in sql:self.allow=False
            if 'allow_connections true' in sql:self.allow=True
            row={'pid':123,'maintenance_database':'postgres','role':'axiom_admin','server_version_num':'170006',
                 'encrypted_transport':True,'stats_visible':True,'database_oid':16500,
                 'database_name':'axiom_proof_preprod','allow_connections':self.allow,
                 'owner_capable':True,'shared_preloads':'pg_stat_statements'}
        if self.mutate:self.mutate(row,sql)
        return row

class Cloud:
    def __init__(self):self.calls=[];self.fail=None
    def control_ready(self,binding):
        self.calls.append('control')
        if self.fail=='control':raise ValueError('unpublished state missing')
    def seed(self,binding,body):
        self.calls.append('seed')
        if self.fail=='seed':raise ValueError('create or reread uncertain')
        return {'seed_generation':'765','seed_body_sha256':hashlib.sha256(body).hexdigest()}

def run(session=None,cloud=None,record=None):
    source,binding=inputs();session=session or Session();cloud=cloud or Cloud();events=[]
    result=gate.fenced_seed(source,binding,session,cloud,record or (lambda stage,value:events.append(stage)))
    return result,session,cloud,events

def test_success_orders_startup_lock_before_clients_and_ready_before_reopen():
    receipt,session,cloud,events=run()
    assert receipt['admission_reopened'] is True and session.allow is True
    assert receipt['seed_body_sha256']==inputs()[1]['seed_body_sha256']
    locks=next(i for i,v in enumerate(session.calls) if 'startup_locks' in v)
    clients=next(i for i,v in enumerate(session.calls) if "'clients'" in v)
    assert locks<clients and events.index('ready_before_reopen')<events.index('reopened')
    assert cloud.calls==['control','control','seed','control']

@pytest.mark.parametrize('attribute,value',[('locks',1),('clients',[{'pid':999}]),('workers',[{'backend_type':'unknown'}]),('prepared',1),('other_admin',1)])
def test_activity_refusal_preserves_committed_fence_without_seed_or_reopen(attribute,value):
    session=Session();setattr(session,attribute,value);cloud=Cloud()
    with pytest.raises(ValueError):run(session,cloud)
    assert session.allow is False and 'seed' not in cloud.calls
    assert not any('allow_connections true' in sql for sql in session.calls)

@pytest.mark.parametrize('key,value',[('pid',None),('encrypted_transport',False),('stats_visible',False),('owner_capable',False),('server_version_num','150018'),('server_version_num','180000'),('shared_preloads','unknown_worker'),('database_oid',None)])
def test_authority_or_native_identity_refusal_before_any_change(key,value):
    session=Session();session.mutate=lambda row,sql:row.update({key:value}) if key in row else None
    with pytest.raises(ValueError):run(session)
    assert session.allow is True
    assert not any('alter database' in sql for sql in session.calls)

def test_backend_replacement_after_close_refuses_and_preserves():
    session=Session()
    session.mutate=lambda row,sql:row.update(pid=456) if not session.allow else None
    with pytest.raises(ValueError):run(session)
    assert session.allow is False

def test_seed_failure_does_not_reopen_or_retry():
    session=Session();cloud=Cloud();cloud.fail='seed'
    with pytest.raises(ValueError):run(session,cloud)
    assert session.allow is False and cloud.calls.count('seed')==1

def test_ready_receipt_record_failure_does_not_reopen():
    session=Session()
    def record(stage,value):
        if stage=='ready_before_reopen':raise OSError('storage unavailable')
    with pytest.raises(OSError):run(session,record=record)
    assert session.allow is False

@pytest.mark.parametrize('key,value',[('release_sha','b'*40),('seed_body_sha256','c'*64),('seed_created_unix',True),('drain_seconds',1201),('database_name','production'),('target_manifest_sha256','d'*64)])
def test_binding_refuses_wrong_target_release_body_and_bounds(key,value):
    source,binding=inputs();binding[key]=value
    with pytest.raises(ValueError):gate.admission_binding(source,binding)

def test_arbitrary_exclusive_boolean_cannot_replace_bootstrap_receipts():
    source,binding=inputs();binding['bootstrap_receipts']={'exclusive_client_adoption':True}
    with pytest.raises(ValueError):gate.admission_binding(source,binding)

class REST(gate.JobCloud):
    def __init__(self,responses):self.responses=iter(responses);self.urls=[];self.project='test-project'
    def request(self,url,**kwargs):
        self.urls.append((url,kwargs));result=next(self.responses)
        if isinstance(result,Exception):raise result
        return gate.canonical_bytes(result) if isinstance(result,(dict,list)) else result

def test_gcs_one_create_generation_pinned_metadata_and_exact_body():
    source,binding=inputs();body=b'{"exact":true}\n'
    meta={'bucket':binding['target']['bucket'],'name':binding['target']['object'],'generation':'123'}
    cloud=REST([meta,meta,body]);cloud.seed(binding,body)
    assert 'ifGenerationMatch=0' in cloud.urls[0][0]
    assert all('generation=123' in url for url,_ in cloud.urls[1:])

@pytest.mark.parametrize('bad',[b'wrong',{'generation':'124'}])
def test_gcs_mismatched_body_or_generation_refuses(bad):
    source,binding=inputs();body=b'exact';meta={'bucket':binding['target']['bucket'],'name':binding['target']['object'],'generation':'123'}
    responses=[meta,bad,body] if isinstance(bad,dict) else [meta,meta,bad]
    with pytest.raises(ValueError):REST(responses).seed(binding,body)

@pytest.mark.parametrize('status',[403,409,500])
def test_scheduler_error_never_masquerades_as_absence(status):
    with pytest.raises(ValueError):REST([{'services':[]},{'projectId':'test-project'},{},gate.CloudRefusal(status)]).control_ready(inputs()[1])

def test_exact_scheduler_absence_or_paused_permits_control_gate():
    REST([{'services':[]},{'projectId':'test-project'},{},gate.CloudRefusal(404)]).control_ready(inputs()[1])
    REST([{'services':[]},{'projectId':'test-project'},{},{'state':'PAUSED'}]).control_ready(inputs()[1])

def test_published_frontend_refuses():
    with pytest.raises(ValueError):REST([{'services':[{'name':'projects/test-project/locations/asia-south1/services/axiom-proof-preprod-marketing'}]},{'projectId':'test-project'},{}]).control_ready(inputs()[1])


def auth_service(ingress='INGRESS_TRAFFIC_ALL'):
    return {'name':'projects/test-project/locations/asia-south1/services/axiom-proof-preprod-auth',
            'ingress':ingress,'template':{'scaling':{'minInstanceCount':0}}}

def test_canonical_private_iam_all_ingress_without_ancestors_is_supported():
    cloud=REST([{'services':[auth_service()]},{'projectId':'test-project'},{},{},{'state':'PAUSED'}])
    cloud.control_ready(inputs()[1])
    assert any('/v2/projects/test-project/locations/asia-south1/services/' in url and ':getIamPolicy' in url for url,_ in cloud.urls)

@pytest.mark.parametrize('members', [['allUsers'],['allAuthenticatedUsers']])
def test_project_inherited_public_policy_refuses(members):
    with pytest.raises(ValueError,match='project public IAM'):
        REST([{'services':[auth_service()]},{'projectId':'test-project'},
              {'bindings':[{'role':'roles/run.invoker','members':members}]}]).control_ready(inputs()[1])

def test_unknown_ancestor_iam_requires_internal_bootstrap_ingress():
    with pytest.raises(ValueError,match='Ancestor IAM'):
        REST([{'services':[auth_service()]},{'projectId':'test-project','parent':'folders/123'},{}]).control_ready(inputs()[1])
    REST([{'services':[auth_service('INGRESS_TRAFFIC_INTERNAL_ONLY')]},
          {'projectId':'test-project','parent':'folders/123'},{},{},{'state':'PAUSED'}]).control_ready(inputs()[1])

def test_service_level_minimum_cannot_hide_behind_zero_revision_minimum():
    service=auth_service();service['scaling']={'minInstanceCount':1}
    with pytest.raises(ValueError,match='zero minimum'):
        REST([{'services':[service]},{'projectId':'test-project'},{}]).control_ready(inputs()[1])

def test_service_public_binding_refuses_even_when_project_is_private():
    with pytest.raises(ValueError,match='Public Auth'):
        REST([{'services':[auth_service()]},{'projectId':'test-project'},{},
              {'bindings':[{'members':['allUsers']}]}]).control_ready(inputs()[1])
