"""Offline, checksum-bound SPIRE payload and normal-restart service preparation."""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

from lib.spire_deployment import VERSION, RELEASE_SHA256, deployment_bundle

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/workload'))
from spire_host import manifest
from spire_state import policy as state_policy

MAX_ARCHIVE = 128 * 1024 * 1024
MAX_BINARY = 192 * 1024 * 1024


def selected_binary(raw: bytes, arch: str, role: str) -> tuple[str, bytes]:
    if arch not in RELEASE_SHA256 or role not in ('issuer', 'runner') or len(raw) > MAX_ARCHIVE or hashlib.sha256(raw).hexdigest() != RELEASE_SHA256[arch]:
        raise ValueError('SPIRE archive refused')
    root = f'spire-{VERSION}'
    directories = {root, root+'/bin', root+'/conf', root+'/conf/server', root+'/conf/agent'}
    regular = {root+'/LICENSE', root+'/README.md', root+'/conf/server/server.conf', root+'/conf/agent/agent.conf', root+'/bin/spire-server', root+'/bin/spire-agent'}
    selected = 'spire-server' if role == 'issuer' else 'spire-agent'
    # Never extract archive paths. Even a checksum-bound future release must
    # satisfy the inventory, type and size contract before its selected binary
    # is read as bytes and written to our own fixed output filename.
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        seen, total, member = set(), 0, None
        for item in archive:
            if item.name in seen or item.pax_headers or item.name not in directories | regular:
                raise ValueError('archive inventory refused')
            seen.add(item.name)
            total += item.size
            if total > 256 * 1024 * 1024:
                raise ValueError('archive expansion refused')
            if item.name in directories:
                if not item.isdir() or item.size != 0:
                    raise ValueError('archive directory refused')
            elif not item.isfile() or not 0 < item.size <= (MAX_BINARY if '/bin/' in item.name else 65536) or item.mode & 0o7000:
                raise ValueError('archive member refused')
            if item.name == root+'/bin/'+selected:
                member = item
        if seen != directories | regular or member is None:
            raise ValueError('archive incomplete')
        stream = archive.extractfile(member)
        if stream is None:
            raise ValueError('archive binary unavailable')
        with stream:
            binary = stream.read(MAX_BINARY + 1)
        if len(binary) != member.size or binary[:6] != b'\x7fELF\x02\x01' or int.from_bytes(binary[18:20], 'little') != {'amd64':62, 'arm64':183}[arch]:
            raise ValueError('binary architecture refused')
    return selected, binary


def escape_device(uuid: str) -> str:
    return 'dev-disk-by\\x2duuid-' + uuid.replace('-', '\\x2d') + '.device'


def units(role: str, uuid: str, node_id: str | None) -> dict[str, bytes]:
    prefix = f'/opt/axiom/spire/{VERSION}'
    service = f'axiom-spire-{role}.service'
    device = escape_device(uuid)
    mount = f'''[Unit]
Description=Axiom reviewed SPIRE state disk
BindsTo={device}
After={device}
Before={service}

[Mount]
What=/dev/disk/by-uuid/{uuid}
Where=/var/lib/spire
Type=ext4
Options=rw,nosuid,nodev,noexec
DirectoryMode=0700
TimeoutSec=30
'''
    runner = role == 'runner'
    binary, config, runtime = ('spire-agent','agent','spire-admin') if runner else ('spire-server','server','spire-server')
    dependencies = ' docker.service' if runner else ''
    wants = 'Wants=axiom-spire-health.service\n' if runner else ''
    runtime_check = f'ExecStartPre=/usr/bin/python3 -I -B {prefix}/spire_host.py --runtime runner\n' if runner else ''
    capabilities = 'CAP_DAC_READ_SEARCH CAP_SYS_PTRACE' if runner else ''
    main = f'''[Unit]
Description=Axiom SPIRE {role} (initialized state only)
BindsTo=var-lib-spire.mount{dependencies}
After=var-lib-spire.mount network-online.target{dependencies}
Wants=network-online.target
{wants}StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
User=root
Group=root
UMask=0077
ExecStartPre=/usr/bin/python3 -I -B {prefix}/spire_host.py --installed {role}
ExecStartPre=/usr/bin/python3 -I -B {prefix}/spire_state.py --ready {role}
{runtime_check}ExecStart=/usr/local/bin/{binary} run -config /etc/axiom/spire/{config}.conf
ExecStartPost=/usr/bin/python3 -I -B {prefix}/spire_host.py --wait {role}
RuntimeDirectory={runtime}
RuntimeDirectoryMode=0700
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
KillMode=control-group
NoNewPrivileges=yes
CapabilityBoundingSet={capabilities}
ProtectSystem=full
ReadOnlyPaths=/opt
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitCORE=0
TasksMax=256
MemoryMax=512M
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
'''
    result = {'state.mount':mount.encode(), 'spire.service':main.encode()}
    if role in ('issuer', 'runner'):
        enroll = main.split('[Install]')[0].replace(
            f'Description=Axiom SPIRE {role} (initialized state only)',
            f'Description=Axiom explicitly permitted first {role} initialization')
        enroll = enroll.replace('ExecStartPre=/usr/bin/python3 -I -B '+prefix+f'/spire_state.py --ready {role}',
            'ExecStartPre=/usr/bin/python3 -I -B '+prefix+f'/spire_enrollment.py --permit {role}\n'
            'ExecStartPre=/usr/bin/python3 -I -B '+prefix+f'/spire_state.py --empty {role}')
        enroll = enroll.replace('Restart=on-failure', 'Restart=no\nRuntimeMaxSec=60')
        enroll = enroll.replace('Wants=axiom-spire-health.service\n', '')
        result['enroll.service'] = enroll.encode()

    if runner:
        health = f'''[Unit]
Description=Axiom bounded SPIRE issuer synchronization observation
BindsTo=axiom-spire-runner.service var-lib-spire.mount
After=axiom-spire-runner.service var-lib-spire.mount
PartOf=axiom-spire-runner.service
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
User=root
Group=root
UMask=0077
ExecStartPre=/usr/bin/python3 -I -B {prefix}/spire_host.py --installed runner
ExecStartPre=/usr/bin/python3 -I -B {prefix}/spire_host.py --runtime runner
ExecStart=/usr/bin/python3 -I -B {prefix}/spire_health.py --watch {node_id}
Restart=on-failure
RestartSec=2
TimeoutStartSec=30
TimeoutStopSec=5
KillMode=control-group
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ReadWritePaths=/run/spire-health
ProtectHome=yes
PrivateDevices=yes
InaccessiblePaths=-/run/docker.sock /var/lib/spire
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX
LimitCORE=0
TasksMax=64
MemoryMax=256M
StandardOutput=null
StandardError=null
'''
        result['health.service'] = health.encode()
    return result


def prepare(value: object, archive: bytes, ca: bytes | None = None) -> tuple[bytes, dict[str, bytes]]:
    fields = {'schemaVersion','platform','architecture','role','filesystemUuid','spirePolicy','bootstrapCaSha256'}
    if not isinstance(value, dict) or set(value) != fields or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['platform'] != 'ubuntu-24.04':
        raise ValueError('host policy refused')
    policy_bundle = deployment_bundle(value['spirePolicy'])
    role, arch = value['role'], value['architecture']
    binary_name, binary = selected_binary(archive, arch, role)
    node = json.loads(policy_bundle['release.json'])['expectedNodeId'] if role == 'runner' else None
    binding = state_policy({'schemaVersion':1, 'role':role, 'filesystemUuid':value['filesystemUuid'], 'trustDomain':value['spirePolicy']['trustDomain'], 'nodeId':node})
    payload = {binary_name:binary, 'state.json':(json.dumps(binding,indent=2)+'\n').encode(), 'spire.conf':policy_bundle['server.conf' if role=='issuer' else 'agent.conf'].encode(), **units(role,binding['filesystemUuid'],node)}
    for name in ('spire_host.py','spire_state.py','spire_enrollment.py') + (('spire_health.py','spire_volumes.py','controller_files.py','controller_placement.py','controller_runtime.py','controller_transition.py') if role=='runner' else ()):
        payload[name] = (ROOT/'infra/workload'/name).read_bytes()
    if role == 'runner':
        expected = value['bootstrapCaSha256']
        if not isinstance(expected,str) or not re.fullmatch(r'[0-9a-f]{64}',expected) or ca is None or not 0 < len(ca) <= 65536 or hashlib.sha256(ca).hexdigest() != expected or not ca.startswith(b'-----BEGIN CERTIFICATE-----\n') or not ca.endswith(b'-----END CERTIFICATE-----\n'):
            raise ValueError('reviewed CA refused')
        payload['bootstrap.pem'] = ca
    elif ca is not None or value['bootstrapCaSha256'] is not None:
        raise ValueError('issuer CA input refused')
    metadata = manifest({'schemaVersion':1, 'spireVersion':VERSION, 'platform':value['platform'], 'architecture':arch, 'role':role, 'files':{name:hashlib.sha256(data).hexdigest() for name,data in payload.items()}})
    return (json.dumps(metadata,indent=2,sort_keys=True)+'\n').encode(), payload
