"""Native reviewed cutover and reverse transition, using the existing local-node fixture.

Systemd, files, journals and Docker ownership are real. Only the earlier fixture's
placement shim/synthetic process stand in for GCP and application readiness.
"""
import hashlib
import json
import uuid
from pathlib import Path


def accept(directory, tenant, old_sha, old_generation, old_review, old_placement, file_review, payload,
           production_path, fixture_path, wrapper, runtime_helper, cli, run, control, wait_for,
           current, running, attempts, profile_paths):
    encode=lambda value:(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    digest=lambda raw:hashlib.sha256(raw).hexdigest()
    def save(path,data):path.write_bytes(data);path.chmod(0o600)
    tool=['/usr/bin/python3','-I','-B','/opt/axiom/spire/1.15.3/controller_transition.py']
    state=Path('/var/lib/axiom-controller-transitions')/tenant
    profiles=Path('/etc/axiom/controller-runtime')
    results={};old_unit=production_path.read_bytes();old_fixture=fixture_path.read_bytes()
    changed={**payload,'backend.key':b'synthetic-renewed-controller-credential-not-real-000000000'}
    manifest={**file_review,'files':{name:digest(data) for name,data in changed.items()}}
    raw=encode(manifest);generation=digest(raw);source=directory/'next-files';source.mkdir(mode=0o700)
    for name,data in {'manifest.json':raw,**changed}.items():save(source/name,data)
    run(['/usr/bin/python3','-I','-B','/opt/axiom/spire/1.15.3/controller_files.py','--install',str(source),generation])
    placed={**old_placement,'controllerManifestSha256':generation};placed_path=directory/'next-placement.json';save(placed_path,encode(placed))
    old_value=json.loads(old_review.read_bytes());value={**old_value,'placementFile':str(placed_path),'placementSha256':digest(placed_path.read_bytes())}
    next_path=directory/'next-runtime.json';save(next_path,encode(value));next_sha=digest(next_path.read_bytes());profile_paths.add(profiles/(next_sha+'.json'))
    review={'schemaVersion':1,'tenantId':tenant,'approvalReference':str(uuid.uuid4()),'previousTransitionSha256':None,'previousProfileSha256':old_sha,'nextProfileFile':str(next_path),'nextProfileSha256':next_sha,'previousGenerationSha256':old_generation,'nextGenerationSha256':generation}
    request=directory/'transition.json';save(request,encode(review));sha=digest(request.read_bytes())
    def operation(mode,success=True):
        result=run([*tool,'--'+mode,str(request),sha],check=False)
        assert (result.returncode==0)==success,'transition CLI result refused'
    def update_fixture():
        save(fixture_path,production_path.read_bytes().replace((runtime_helper+' --run').encode(),(str(wrapper)+' --run').encode()))
        control('daemon-reload')
    # A root operator's concurrent live fixture holds the same tenant lifetime
    # lock even though the canonical production service is inactive.
    control('start',fixture_path.name);wait_for(running)
    operation('publish',False);assert not state.exists()
    control('stop',fixture_path.name)
    results['controller-transition-refuses-live-owned-lifetime']=True
    control('enable',production_path.name)
    try:operation('publish',False);assert production_path.read_bytes()==old_unit
    finally:control('disable',production_path.name)
    dropin=Path(str(production_path)+'.d');dropin.mkdir(mode=0o755);override=dropin/'fixture.conf';save(override,b'[Service]\nEnvironment=UNREVIEWED=1\n')
    control('daemon-reload')
    try:operation('publish',False);assert not state.exists()
    finally:override.unlink();dropin.rmdir();control('daemon-reload')
    results['controller-transition-refuses-enabled-or-overridden-unit']=True
    # Deliberately restart a stopped exact-ID container behind its stop receipt.
    previous=attempts()[0];previous_id=json.loads((previous/'container.json').read_bytes())['containerId']
    run(['docker','start',previous_id]);operation('publish',False)
    assert not state.exists();run(['docker','stop','--time','90',previous_id])
    results['controller-transition-refuses-stale-stop-receipt-with-live-container']=True
    # Inject loss of the publication acknowledgement after the real atomic
    # rename, then recover with the unmodified production CLI.
    interrupted=directory/'interrupt-transition.py'
    save(interrupted,b'''import sys
sys.path.insert(0,'/opt/axiom/spire/1.15.3')
import controller_transition as transition
original=transition.enrollment.create
def fail(path,data):
 if path.name=='published.json':raise ValueError('fixture interrupted publication')
 original(path,data)
transition.enrollment.create=fail
try:transition.main()
except Exception:sys.exit(1)
''')
    failed=run(['/usr/bin/python3','-I','-B',str(interrupted),'--publish',str(request),sha],check=False)
    assert failed.returncode!=0 and production_path.read_bytes()!=old_unit
    assert not (state/sha/'published.json').exists()
    inode=production_path.stat().st_ino;operation('resume');assert production_path.stat().st_ino==inode
    results['controller-interrupted-publication-resumes-without-replacing-reviewed-unit']=True
    new_unit=production_path.read_bytes()
    assert new_unit!=old_unit and (state/sha/'published.json').exists() and not (state/sha/'confirmed.json').exists()
    assert control('is-enabled',production_path.name,check=False).stdout.strip()==b'disabled'
    assert control('show','--property=ActiveState','--value',production_path.name).stdout.strip()==b'inactive'
    for selected in (old_sha,next_sha):assert run([*cli,'--run',selected],check=False).returncode!=0
    # Inactive unreferenced units may be garbage-collected and loaded afresh.
    # NeedDaemonReload describes loaded state, not who invoked a reload; the
    # deterministic stale-state refusal is covered by the state-machine tests.
    results['controller-transition-publishes-disabled-unit-and-blocks-unconfirmed-starts']=True
    control('daemon-reload');operation('confirm');operation('resume');operation('confirm')
    assert run([*cli,'--run',old_sha],check=False).returncode!=0
    update_fixture();control('start',fixture_path.name);wait_for(running)
    active=current();identifier=json.loads((active/'container.json').read_bytes())['containerId']
    inspect=json.loads(run(['docker','inspect',identifier]).stdout)[0]
    assert inspect['Config']['Labels']['ai.axiomproof.controller.profile']==next_sha
    expected=str(Path('/etc/axiom/controllers')/tenant/generation/'files')
    assert any(m['Source']==expected and m['Destination']=='/run/controller-secrets' and m['RW'] is False for m in inspect['Mounts'])
    assert run(['docker','exec',identifier,'cat','/run/controller-secrets/backend.key']).stdout==changed['backend.key']
    control('stop',fixture_path.name);assert (active/'stopped.json').exists()
    results['controller-confirmed-cutover-starts-fresh-id-with-new-protected-generation']=True
    # A separate reverse review can return to a prior immutable generation;
    # real credentials must still be unexpired/unrevoked at application startup.
    review={**review,'approvalReference':str(uuid.uuid4()),'previousTransitionSha256':sha,'previousProfileSha256':next_sha,'nextProfileFile':str(old_review),'nextProfileSha256':old_sha,'previousGenerationSha256':generation,'nextGenerationSha256':old_generation}
    first_sha=sha;request=directory/'reverse-transition.json';save(request,encode(review));sha=digest(request.read_bytes())
    operation('publish');control('daemon-reload');operation('confirm');assert production_path.read_bytes()==old_unit
    assert (state/first_sha/'confirmed.json').exists() and (state/sha/'confirmed.json').exists()
    assert run([*cli,'--run',next_sha],check=False).returncode!=0
    update_fixture();assert fixture_path.read_bytes()==old_fixture
    control('start',fixture_path.name);wait_for(running);back=current()
    back_id=json.loads((back/'container.json').read_bytes())['containerId'];assert back_id!=identifier
    assert run(['docker','exec',back_id,'cat','/run/controller-secrets/backend.key']).stdout==payload['backend.key']
    control('stop',fixture_path.name);assert (back/'stopped.json').exists()
    results['controller-separately-reviewed-reverse-transition-preserves-history-and-new-lifetime']=True
    # A second request claiming the older predecessor cannot fork the chain.
    branch={**review,'approvalReference':str(uuid.uuid4())};request=directory/'stale-transition.json';save(request,encode(branch));sha=digest(request.read_bytes())
    operation('publish',False);assert production_path.read_bytes()==old_unit
    results['controller-transition-stale-predecessor-refused-without-replacement']=True
    return results
