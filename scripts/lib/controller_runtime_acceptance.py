"""Disposable native lifetime fixture; synthetic process, not production readiness.

The actual production entrypoint remains covered by controller-entrypoint-acceptance.ts.
Only this fixture substitutes local join-token placement, never the shipped helper.
"""
import hashlib
import json
import shutil
import time
import uuid
from pathlib import Path


def accept(root, prefix, alpine, tenant, service_config, manifest_sha, api_volume, health_volume, foreign, run, control, active, wait_for):
    directory = root/'controller-runtime-fixture'; directory.mkdir(mode=0o700)
    image = prefix+':supervisor-fixture'
    production = 'axiom-controller-'+tenant+'.service'
    fixture_unit = 'axiom-controller-fixture-'+tenant+'.service'
    units = [Path('/etc/systemd/system')/name for name in (production, fixture_unit)]
    state = Path('/var/lib/axiom-controller')/tenant
    profiles = Path('/etc/axiom/controller-runtime')
    controller_root = Path('/etc/axiom/controllers')/tenant
    helper = '/opt/axiom/spire/1.15.3/controller_runtime.py'
    cli = ['/usr/bin/python3', '-I', '-B', helper]
    ids = set(); profile_path = None; outcomes = {}
    if state.exists() or any(p.exists() for p in units): raise ValueError('fresh controller fixture required')
    try:
        # Deliberately synthetic executable at the production command location.
        # No backend, real TLS, task, token or workload identity is consumed.
        (directory/'node').write_text('#!/bin/sh\ntrap "exit 0" TERM INT\nwhile :; do sleep 1 & wait $!; done\n')
        (directory/'node').chmod(0o755)
        (directory/'Dockerfile').write_text(f'''FROM {alpine}
RUN apk add --no-cache tini
COPY node /usr/local/bin/node
ENV PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PNPM_HOME=/pnpm NODE_ENV=production TSX_DISABLE_CACHE=1 NODE_VERSION=0.0.0 YARN_VERSION=0.0.0
WORKDIR /app/services/bff
USER 20000:20000
ENTRYPOINT ["/sbin/tini","--","node","--import","/app/node_modules/tsx/dist/loader.mjs","src/assessment-controller-service.ts"]
''')
        run(['docker', 'build', '-t', image, str(directory)], timeout=180)
        image_id = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]).stdout.decode().strip()
        payload = {'service.json': json.dumps(service_config).encode(), 'backend.key': b'synthetic-runtime-key-not-real-000000000', 'tls.key': b'synthetic-runtime-tls-key', 'tls.crt': b'synthetic-runtime-certificate'}
        file_review = {'schemaVersion': 1, 'tenantId': tenant, 'spireManifestSha256': manifest_sha, 'controllerImage': image_id, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()}}
        encode = lambda value: (json.dumps(value, sort_keys=True, separators=(',', ':'))+'\n').encode()
        raw = encode(file_review); file_sha = hashlib.sha256(raw).hexdigest()
        source = directory/'files'; source.mkdir(mode=0o700)
        for name, data in {'manifest.json': raw, **payload}.items(): (source/name).write_bytes(data); (source/name).chmod(0o600)
        run(['/usr/bin/python3', '-I', '-B', '/opt/axiom/spire/1.15.3/controller_files.py', '--install', str(source), file_sha])
        import ipaddress
        interfaces = json.loads(run(['/usr/sbin/ip', '-j', '-4', 'address', 'show', 'up']).stdout)
        private = [a['local'] for i in interfaces if i.get('operstate') == 'UP' and 'LOOPBACK' not in i.get('flags', []) for a in i.get('addr_info', []) if a.get('family') == 'inet' and a.get('scope') == 'global' and any(ipaddress.ip_address(a['local']) in ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))]
        if not private: raise ValueError('fixture private interface required')
        placed = {'schemaVersion': 1, 'tenantId': tenant, 'controllerManifestSha256': file_sha, 'zone': 'asia-south1-a', 'privateIp': private[0]}
        placed_raw = encode(placed); placement_path = directory/'placement.json'; placement_path.write_bytes(placed_raw); placement_path.chmod(0o600)
        value = {'schemaVersion': 1, 'tenantId': tenant, 'placementFile': str(placement_path), 'placementSha256': hashlib.sha256(placed_raw).hexdigest(), 'backendUrl': 'https://synthetic.invalid'}
        raw = encode(value); sha = hashlib.sha256(raw).hexdigest()
        review = directory/'runtime.json'; review.write_bytes(raw); review.chmod(0o600)
        profile_path = profiles/(sha+'.json')
        run([*cli, '--install', str(review), sha]); run([*cli, '--install', str(review), sha])
        assert all(p.stat().st_uid == 0 and p.stat().st_mode & 511 == 0o600 for p in (units[0], profile_path))
        run(['/usr/bin/systemd-analyze', 'verify', '--man=no', str(units[0])])
        assert control('is-enabled', production, check=False).returncode != 0
        assert not state.exists()
        outcomes['controller-unit-delivery-is-reviewed-disabled-and-idempotent'] = True
        original_unit = units[0].read_bytes()
        units[0].write_bytes(original_unit+b'\n# conflicting fixture delivery\n')
        assert run([*cli, '--install', str(review), sha], check=False).returncode != 0
        assert units[0].read_bytes() != original_unit
        units[0].write_bytes(original_unit)
        outcomes['controller-install-conflict-preserved-without-replacement'] = True
        control('daemon-reload'); control('start', production, check=False)
        wait_for(lambda: control('show', '--property=ActiveState', '--value', production).stdout.strip() == b'failed')
        assert not list(state.glob('*/intent.json'))
        outcomes['controller-production-placement-refuses-local-node-before-create'] = True
        control('reset-failed', production)
        # Private fixture wrapper only: replace GCP metadata comparison with the
        # existing local-node binding. All production file/volume/host checks run.
        wrapper = directory/'local_fixture.py'
        wrapper.write_text('''import hashlib,json,sys
from pathlib import Path
sys.path.insert(0,'/opt/axiom/spire/1.15.3')
import controller_runtime as runtime
import controller_placement as placement
import controller_files as files
import spire_enrollment as enrollment
import spire_volumes as volumes
def local_placement(path,sha):
 raw=placement.host.read_file(path,4096,0o600)
 if hashlib.sha256(raw).hexdigest()!=sha:raise ValueError('fixture review changed')
 value=placement.profile(json.loads(raw,object_pairs_hook=placement.host.unique))
 delivered=files.check(value['tenantId'],value['controllerManifestSha256'])
 review=enrollment.load(delivered.parent/'manifest.json')
 mapping=volumes.prepare(review['spireManifestSha256'],check=True)
 placement.assigned(value['privateIp'])
 return {'profile':value,'files':str(delivered),'image':review['controllerImage'],'volumes':mapping['volumes']}
placement.check=local_placement
original=runtime.docker
def uncertain(*args,**kwargs):
 if args[:2]==('container','start') and Path(__file__).with_name('uncertain-start').exists():
  raise ValueError('fixture queued start without state transition')
 result=original(*args,**kwargs)
 if args[0]=='create' and Path(__file__).with_name('uncertain').exists():
  Path(__file__).with_name('created-id').write_bytes(result)
  raise ValueError('fixture lost create response')
 return result
runtime.docker=uncertain
try: runtime.main()
except Exception as error:
 import traceback
 frames=[frame.name+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)]
 if str(error).startswith('created controller confinement refused: '):frames.append(str(error))
 Path(__file__).with_name('failure-location').write_text(' / '.join(frames))
 raise
'''); wrapper.chmod(0o600)
        units[1].write_bytes(units[0].read_bytes().replace((helper+' --run').encode(), (str(wrapper)+' --run').encode())); units[1].chmod(0o600)
        control('daemon-reload')
        def attempts(): return sorted(p for p in state.iterdir() if p.is_dir())
        def current():
            pending = [p for p in attempts() if (p/'container.json').exists() and not (p/'stopped.json').exists()]
            return pending[0] if len(pending) == 1 else None
        def running():
            path = current()
            if path is None: return False
            identifier = json.loads((path/'container.json').read_text())['containerId']; ids.add(identifier)
            return run(['docker', 'inspect', '--format', '{{.State.Running}}', identifier], check=False).stdout.strip() == b'true'
        control('start', fixture_unit); wait_for(running)
        first = current(); first_id = json.loads((first/'container.json').read_text())['containerId']
        assert run([*cli, '--run', sha], check=False).returncode != 0
        assert running() and len(attempts()) == 1
        outcomes['controller-concurrent-start-refused-without-disturbing-owner'] = True
        control('stop', fixture_unit)
        assert (first/'stopped.json').exists()
        observation = json.loads(run(['docker', 'inspect', first_id]).stdout)[0]
        assert observation['State']['Running'] is False and observation['State']['ExitCode'] == 0
        assert observation['HostConfig']['PortBindings'] == {'8443/tcp': [{'HostIp': private[0], 'HostPort': '8443'}]}
        assert observation['Config']['User'] == '20000:20000' and observation['HostConfig']['ReadonlyRootfs'] is True
        outcomes['controller-supervisor-private-confinement-and-graceful-owned-stop'] = True
        control('start', fixture_unit); wait_for(running)
        second = current(); second_id = json.loads((second/'container.json').read_text())['containerId']
        assert second_id != first_id and second != first
        run(['docker', 'kill', second_id])
        wait_for(lambda: control('show', '--property=ActiveState', '--value', fixture_unit).stdout.strip() == b'failed')
        assert (second/'stopped.json').exists() and len(attempts()) == 2
        outcomes['controller-unexpected-exit-fails-without-automatic-restart'] = True
        control('reset-failed', fixture_unit); control('start', fixture_unit); wait_for(running)
        third = current(); record = third/'container.json'; original_record = record.read_bytes()
        original_id = json.loads(original_record)['containerId']
        foreign_id = run(['docker', 'inspect', '--format', '{{.Id}}', foreign]).stdout.decode().strip()
        record.write_bytes(encode({'schemaVersion': 1, 'containerId': foreign_id}))
        control('kill', '--kill-whom=main', '--signal=SIGKILL', fixture_unit)
        wait_for(lambda: control('show', '--property=ActiveState', '--value', fixture_unit).stdout.strip() == b'failed')
        assert not (third/'stopped.json').exists()
        assert run(['docker', 'inspect', '--format', '{{.State.Running}}', foreign_id]).stdout.strip() == b'true'
        assert run([*cli, '--stop', tenant, sha], check=False).returncode != 0
        outcomes['controller-foreign-id-refused-without-stopping-foreign-container'] = True
        record.write_bytes(original_record)
        run([*cli, '--stop', tenant, sha])  # Production path; no fixture metadata shim.
        assert (third/'stopped.json').exists()
        assert run(['docker', 'inspect', '--format', '{{.State.Running}}', original_id]).stdout.strip() == b'false'
        outcomes['controller-explicit-owned-recovery-needs-no-placement-service'] = True
        control('reset-failed', fixture_unit); control('start', fixture_unit); wait_for(running)
        killed = current()
        control('kill', '--kill-whom=main', '--signal=SIGKILL', fixture_unit)
        wait_for(lambda: control('show', '--property=ActiveState', '--value', fixture_unit).stdout.strip() == b'failed')
        assert (killed/'stopped.json').exists()
        outcomes['controller-wrapper-death-recovers-exact-id-through-stop-post'] = True
        control('reset-failed', fixture_unit); control('start', fixture_unit); wait_for(running)
        dependent = current()
        control('stop', 'axiom-spire-health.service')
        wait_for(lambda: control('show', '--property=ActiveState', '--value', fixture_unit).stdout.strip() == b'inactive')
        assert (dependent/'stopped.json').exists()
        control('reset-failed', 'axiom-spire-health.service'); control('start', 'axiom-spire-health.service')
        wait_for(lambda: json.loads(Path('/run/spire-health/status.json').read_text()).get('healthy') is True)
        assert not active(fixture_unit)
        outcomes['controller-dependency-loss-stops-owner-without-auto-resume'] = True
        # A successfully stopped unit may already be unloaded by systemd;
        # reset-failed is unnecessary here and would refuse an unloaded unit.
        (directory/'uncertain-start').write_text('fixture')
        control('start', fixture_unit, check=False)
        wait_for(lambda: control('show', '--property=ActiveState', '--value', fixture_unit).stdout.strip() == b'failed')
        queued = current(); queued_id = json.loads((queued/'container.json').read_text())['containerId']; ids.add(queued_id)
        assert (queued/'start.json').exists() and not (queued/'stopped.json').exists()
        assert run(['docker', 'inspect', '--format', '{{.State.Status}}', queued_id]).stdout.strip() == b'created'
        assert run([*cli, '--stop', tenant, sha], check=False).returncode != 0
        assert run([*cli, '--run', sha], check=False).returncode != 0
        # Fixture-only simulation of the daemon eventually completing the
        # uncertain request. Production never reissues start during recovery.
        run(['docker', 'start', queued_id]); run([*cli, '--stop', tenant, sha])
        assert (queued/'stopped.json').exists()
        (directory/'uncertain-start').unlink()
        outcomes['controller-uncertain-start-remains-blocked-until-owned-stop-observed'] = True
        control('reset-failed', fixture_unit); (directory/'uncertain').write_text('fixture')
        control('start', fixture_unit, check=False)
        wait_for(lambda: control('show', '--property=ActiveState', '--value', fixture_unit).stdout.strip() == b'failed')
        uncertain_id = (directory/'created-id').read_text().strip(); ids.add(uncertain_id)
        last = next(p for p in attempts() if not (p/'container.json').exists())
        assert (last/'intent.json').exists() and not (last/'stopped.json').exists()
        assert run(['docker', 'inspect', '--format', '{{.State.Status}}', uncertain_id]).stdout.strip() == b'created'
        assert run([*cli, '--run', sha], check=False).returncode != 0
        assert run([*cli, '--stop', tenant, sha], check=False).returncode != 0
        assert len(attempts()) == 7
        outcomes['controller-uncertain-create-preserves-intent-without-adoption-or-start'] = True
        return outcomes
    finally:
        print('Synthetic controller fixture completed checks: '+', '.join(sorted(outcomes)))
        for name in (fixture_unit, 'axiom-spire-health.service', 'axiom-spire-runner.service'):
            print('Synthetic fixture unit status '+name+': '+control('show', '--property=ActiveState,SubState,Result', name, check=False).stdout.decode().strip().replace('\n', ' '))
        if (directory/'failure-location').exists():
            print('Synthetic controller fixture last failure location: '+(directory/'failure-location').read_text())
        for name in (fixture_unit, production): control('stop', name, check=False)
        # These IDs were captured from fixture-owned receipts or its explicit
        # create-response interception, never inferred from a production name.
        if (directory/'created-id').exists(): ids.add((directory/'created-id').read_text().strip())
        for receipt in state.glob('*/container.json'):
            item = json.loads(receipt.read_text()).get('containerId')
            if item: ids.add(item)
        foreign_id = run(['docker', 'inspect', '--format', '{{.Id}}', foreign], check=False).stdout.decode().strip()
        for identifier in ids-{foreign_id}:
            observed = run(['docker', 'inspect', identifier], check=False)
            if observed.returncode == 0:
                item = json.loads(observed.stdout)[0]
                if item.get('Config', {}).get('Labels', {}).get('ai.axiomproof.controller.tenant') == tenant and item.get('Image') == locals().get('image_id'):
                    run(['docker', 'rm', '-f', identifier], check=False)
        for path in units: path.unlink(missing_ok=True)
        control('daemon-reload')
        if profile_path: profile_path.unlink(missing_ok=True)
        shutil.rmtree(state, ignore_errors=True)
        run(['docker', 'image', 'rm', image], check=False)
