#!/usr/bin/env python3
"""Read-only, reviewed tenant-to-VM admission. Never activates a controller."""
from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, '/opt/axiom/spire/1.15.3')
import controller_files as files
import spire_enrollment as enrollment
import spire_host as host
import spire_volumes as volumes

PATHS = {
    'tenantId': 'instance/attributes/axiom-tenant-id',
    'instanceId': 'instance/id',
    'projectId': 'project/project-id',
    'zone': 'instance/zone',
    'privateIp': 'instance/network-interfaces/0/ip',
}
PRIVATE = tuple(ipaddress.IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def profile(value: object) -> dict:
    keys = {'schemaVersion', 'tenantId', 'controllerManifestSha256', 'zone', 'privateIp'}
    if not isinstance(value, dict) or set(value) != keys or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('placement profile refused')
    tenant = value['tenantId']
    if not isinstance(tenant, str) or str(uuid.UUID(tenant)) != tenant or uuid.UUID(tenant).int == 0:
        raise ValueError('placement tenant refused')
    enrollment.sha(value['controllerManifestSha256'])
    if not isinstance(value['zone'], str) or not re.fullmatch(r'asia-south1-[abc]', value['zone']):
        raise ValueError('Mumbai zone required')
    address = value['privateIp']
    if not isinstance(address, str) or not any(ipaddress.IPv4Address(address) in network for network in PRIVATE):
        raise ValueError('private IPv4 address required')
    return value


def observe() -> dict[str, str]:
    # The caller runs this fixed child under an eight-second total deadline and
    # bounded output. A per-socket timeout alone would permit trickled headers.
    # HTTPConnection does not use proxy environment variables or follow redirects.
    result = {}
    for name, path in PATHS.items():
        connection = http.client.HTTPConnection('169.254.169.254', 80, timeout=1)
        try:
            connection.request('GET', '/computeMetadata/v1/'+path,
                               headers={'Metadata-Flavor': 'Google', 'Connection': 'close'})
            response = connection.getresponse()
            if response.status != 200 or response.headers.get_all('Metadata-Flavor') != ['Google']:
                raise ValueError('metadata response refused')
            raw = response.read(257)
            if not 0 < len(raw) <= 256 or any(char < 33 or char > 126 for char in raw):
                raise ValueError('metadata value refused')
            result[name] = raw.decode('ascii')
        finally:
            connection.close()
    return result


def metadata() -> dict:
    raw = enrollment.command(['/usr/bin/python3', '-I', '-B',
                              str(host.PREFIX/'controller_placement.py'), '--observe'],
                             timeout=8, maximum=2048)
    value = json.loads(raw, object_pairs_hook=host.unique)
    if not isinstance(value, dict) or set(value) != set(PATHS) or any(not isinstance(item, str) for item in value.values()):
        raise ValueError('metadata observation refused')
    return value


def assigned(address: str) -> None:
    raw = enrollment.command(['/usr/sbin/ip', '-j', '-4', 'address', 'show', 'up'], timeout=3)
    interfaces = json.loads(raw, object_pairs_hook=host.unique)
    if not isinstance(interfaces, list) or len(interfaces) > 256:
        raise ValueError('interface observation refused')
    matches = []
    for interface in interfaces:
        if not isinstance(interface, dict) or not isinstance(interface.get('flags'), list) or not isinstance(interface.get('addr_info'), list):
            raise ValueError('interface shape refused')
        for info in interface['addr_info']:
            if not isinstance(info, dict): raise ValueError('address shape refused')
            if info.get('local') == address:
                flags = interface['flags']
                if not {'UP', 'LOWER_UP'} <= set(flags) or 'LOOPBACK' in flags or interface.get('operstate') != 'UP' or info.get('family') != 'inet' or info.get('scope') != 'global' or info.get('preferred_life_time') == 0 or any(info.get(key) is True for key in ('tentative', 'dadfailed', 'deprecated')):
                    raise ValueError('active private interface required')
                matches.append(interface.get('ifindex'))
    if len(matches) != 1 or type(matches[0]) is not int or matches[0] <= 0:
        raise ValueError('unique assigned private address required')


def matched(review: dict, binding: dict, observed: dict) -> None:
    project, instance = binding['nodeId'].rsplit('/', 2)[-2:]
    # Explicitly retain GCP binding even if a fixture changes state.policy.
    if binding['nodeId'] != f"spiffe://{binding['trustDomain']}/spire/agent/gcp_iit/{project}/{instance}" or not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project) or not re.fullmatch(r'[1-9][0-9]{0,19}', instance) or int(instance) > 2**64-1:
        raise ValueError('GCP node binding required')
    if observed.get('tenantId') != review['tenantId'] or observed.get('projectId') != project or observed.get('instanceId') != instance or observed.get('privateIp') != review['privateIp'] or not isinstance(observed.get('zone'), str) or not re.fullmatch(r'projects/[1-9][0-9]{0,19}/zones/'+re.escape(review['zone']), observed['zone']):
        raise ValueError('tenant VM placement refused')


def check(path: Path, expected: str) -> dict:
    enrollment.sha(expected)
    raw = host.read_file(path, 4096, 0o600)
    if enrollment.digest(raw) != expected: raise ValueError('placement review digest refused')
    review = profile(json.loads(raw, object_pairs_hook=host.unique))
    tenant, generation = review['tenantId'], review['controllerManifestSha256']
    delivered = files.check(tenant, generation)
    file_review = files.manifest(enrollment.load(delivered.parent/'manifest.json'))
    spire = file_review['spireManifestSha256']
    binding = enrollment.installed(spire, 'runner')
    observed = metadata()
    matched(review, binding, observed)
    assigned(review['privateIp'])
    mapping = volumes.prepare(spire, check=True)
    # Placement and source delivery are reobserved at the admission boundary.
    # This is a point-in-time result, never a cached startup authorization.
    if metadata() != observed or files.check(tenant, generation) != delivered or enrollment.installed(spire, 'runner') != binding or host.read_file(path, 4096, 0o600) != raw:
        raise ValueError('placement changed during check')
    assigned(review['privateIp'])
    return {'profile': review, 'files': str(delivered), 'image': file_review['controllerImage'], 'volumes': mapping['volumes']}


def main() -> None:
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('root Linux placement check required')
    if sys.argv[1:] == ['--observe']:
        print(json.dumps(observe(), sort_keys=True))
    elif len(sys.argv) == 4 and sys.argv[1] == '--check':
        with enrollment.exclusive(): check(Path(sys.argv[2]), sys.argv[3])
        print('Controller placement verified; no runtime activation or readiness claimed.')
    else: raise ValueError('placement arguments refused')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Controller placement refused; review tenant, VM and protected runtime bindings.', file=sys.stderr)
        sys.exit(1)
