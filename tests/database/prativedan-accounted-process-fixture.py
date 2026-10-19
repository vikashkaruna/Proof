"""Owned native SQL / actual isolated Prativedan processes, never retained state.

Requires a separately reviewed/prebuilt immutable process image. The locally
signed issuer/current-human adapters are engineering fixtures, not GoTrue/SPIRE
identity enrollment or deployed UID/socket qualification.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
PG_IMAGE='sha256:be60aee15997daca475b710b734bc6bfe52cd544dcd7e9fd2ff58210b6747d83'

def main()->None:
    parser=argparse.ArgumentParser()
    parser.add_argument('--process-image',required=True)
    parser.add_argument('--proof-directory',type=Path,required=True)
    parser.add_argument('--malicious-renderer-image')
    args=parser.parse_args()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',args.process_image):raise SystemExit('Immutable reviewed process image required')
    proof=args.proof_directory
    if not proof.is_absolute() or proof.resolve()!=proof or proof.is_symlink() or not proof.is_dir() or any(proof.iterdir()):raise SystemExit('Existing empty absolute proof directory required')
    mode=proof.stat()
    if mode.st_uid!=os.getuid() or stat.S_IMODE(mode.st_mode)!=0o700:raise SystemExit('Owned0700 proof directory required')
    if Path.cwd().resolve()!=ROOT:raise SystemExit('Fixture worktree context refused')
    cid=None
    manifest={'kind':'owned_prativedan172_mounted_process_fixture','retainedRuntimeChanged':False,
        'postgresImage':PG_IMAGE,'processImage':args.process_image,'fullDeploymentQualified':False,
        'sourceHashes':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT/'infra/supabase/migrations/0172_prativedan_accounted_terminal.sql',Path(__file__),ROOT/'tests/database/prativedan-accounted-native-prepare.py',ROOT/'services/bff/scripts/prativedan-accounted-native-driver.ts']}}
    def run(command:list[str],text:str|None=None,timeout:int=120)->str:
        result=subprocess.run(command,input=text,capture_output=True,text=True,cwd=ROOT,timeout=timeout,check=False)
        with (proof/'native.private.log').open('a') as log:
            log.write(result.stdout+result.stderr)
        (proof/'native.private.log').chmod(0o600)
        if result.returncode:raise RuntimeError('Owned fixture command failed; inspect protected log')
        return result.stdout.strip()
    def sql(text:str)->str:
        assert cid is not None
        return run(['docker','exec','-i',cid,'psql','-X','-U','supabase_admin','-d','axiom_proof_local','-v','ON_ERROR_STOP=1','-Atq'],text)
    try:
        inspected=json.loads(run(['docker','image','inspect','--format','{"id":{{json .Id}},"fixture":{{json (index .Config.Labels "com.axiom.fixture")}}}',args.process_image]))
        if inspected!={'id':args.process_image,'fixture':'prativedan172-source-process'}:raise RuntimeError('Reviewed engineering process image refused')
        name='axiom-prativedan-controller-'+uuid.uuid4().hex[:12]
        cid=run(['docker','run','--rm','-d','--network','none','--name',name,
            '--label','com.axiom.fixture=database-policy-test','--label','com.axiom.fixture.project=axiom-db-tests',
            '--label','com.axiom.owner-worktree='+str(ROOT),'-e','POSTGRES_HOST_AUTH_METHOD=trust',PG_IMAGE])
        if not re.fullmatch(r'[a-f0-9]{64}',cid):raise RuntimeError('Owned create response refused')
        manifest['containerId']=cid
        for _ in range(60):
            ready=subprocess.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True,check=False)
            if ready.returncode==0:break
            time.sleep(1)
        else:raise RuntimeError('Owned database readiness unconfirmed')
        run(['docker','exec',cid,'createdb','-U','postgres','axiom_proof_local'])
        sql((ROOT/'tests/database/bootstrap.sql').read_text())
        for helper in ['preprovision-local-custody-verifier.py','preprovision-local-custody-issuer.py']:
            run(['python3','tests/database/lib/'+helper,'--container',cid,'--image',PG_IMAGE])
        run(['python3','scripts/migrate-database.py','--container',cid,'--user','supabase_admin','--database','axiom_proof_local'])
        preparation=run(['python3','tests/database/prativedan-accounted-native-prepare.py'])
        sql(preparation)
        run(['pnpm','exec','tsx','services/bff/scripts/prativedan-accounted-native-driver.ts',cid,args.process_image,str(proof)]+([args.malicious_renderer_image] if args.malicious_renderer_image else []),timeout=240)
        manifest['passed']=True
    finally:
        if cid is not None:
            # Only the immutable CID returned by our successful creation.
            result=subprocess.run(['docker','rm','-f',cid],capture_output=True,text=True,check=False)
            manifest['ownedDatabaseRemoved']=result.returncode==0
        target=proof/'qualification.private.json'
        target.write_text(json.dumps(manifest,indent=2)+'\n');target.chmod(0o600)
    print('Owned Prativedan172 process/SQL fixture qualified; exact owned database removed.')

if __name__=='__main__':main()
