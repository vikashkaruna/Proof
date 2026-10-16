#!/usr/bin/env python3
"""Protected local145 credential administration; no service or policy activation.

The SQL145 policy quorum is authoritative. Issuer settings have their own
review digest and cannot replace the approved deployment-binding digest.
Run with python -I. No password, signing key or token is printed or put in argv.
"""

from __future__ import annotations

import base64
import configparser
import contextlib
import hmac
import importlib.util
import ipaddress
import json
import os
import re
import selectors
import ssl
import stat
import subprocess  # nosec B404 - fixed validated psql executable, no shell
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

# Fixed repository-owned implementation, never a caller-supplied module path.
_spec = importlib.util.spec_from_file_location(
    "axiom_protected_controller_files",
    Path(__file__).resolve().parents[1] / "credential-issuer/issuer.py",
)
if _spec is None or _spec.loader is None:
    raise RuntimeError("Protected issuer unavailable")
_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_files)
read, source, create, sync = _files.read, _files.source, _files.create, _files.sync
ancestry, directory = _files.ancestry, _files.directory
sha, digest, unique = _files.sha, _files.digest, _files.unique
SERVICE = "axiom-proof-local-custody-issuer"
ROLE = "axiom_local_custody_verifier"
PHASE = "input"
UUID = re.compile(
    r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
)
MAX_BYTES = 16384


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf8")


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("identity refused")
    return value


def integer(value, maximum=9007199254740991):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError("integer refused")
    return value


def request(raw: bytes, expected: str, kind: str):
    if not 2 <= len(raw) <= MAX_BYTES or sha(raw) != digest(expected):
        raise ValueError("request digest refused")
    value = json.loads(raw.decode("utf8"), object_pairs_hook=unique)
    common = {"version", "purpose", "credentialId", "tenantId", "reason"}
    fields = (
        {
            "policyId",
            "policySha256",
            "activationEventId",
            "activationEpoch",
            "configurationSha256",
            "workloadId",
            "principalKind",
            "servicePrincipal",
            "operatorId",
            "predecessorId",
            "issuedAt",
            "expiresAt",
        }
        if kind == "issue"
        else {"issuanceSha256"}
    )
    if (
        kind not in ("issue", "revoke")
        or not isinstance(value, dict)
        or set(value) != common | fields
        or type(value["version"]) is not int
        or value["version"] != 1
        or value["purpose"] != "local-custody-credential-" + kind
        or canonical(value) != raw
    ):
        raise ValueError("canonical request refused")
    for key in ("credentialId", "tenantId"):
        identifier(value[key])
    reason = value["reason"]
    if (
        not isinstance(reason, str)
        or not 1 <= len(reason) <= 2000
        or not reason.strip()
        or "\x00" in reason
    ):
        raise ValueError("reason refused")
    if kind == "revoke":
        digest(value["issuanceSha256"])
        return value
    for key in ("policyId", "activationEventId", "workloadId"):
        identifier(value[key])
    for key in ("policySha256", "configurationSha256"):
        digest(value[key])
    for key in ("operatorId", "predecessorId"):
        if value[key] is not None:
            identifier(value[key])
    for key in ("activationEpoch", "issuedAt", "expiresAt"):
        integer(value[key])
    if (
        not 1 <= value["expiresAt"] - value["issuedAt"] <= 86400
        or value["predecessorId"] == value["credentialId"]
        or value["principalKind"] not in ("operator", "producer", "controller")
        or (value["principalKind"] == "operator") != (value["operatorId"] is not None)
        or not isinstance(value["servicePrincipal"], str)
        or not 1 <= len(value["servicePrincipal"]) <= 2048
        or "\x00" in value["servicePrincipal"]
    ):
        raise ValueError("request authority refused")
    return value


def configuration(path: Path, expected: str):
    raw = read(path, MAX_BYTES)
    if sha(raw) != digest(expected):
        raise ValueError("issuer settings digest refused")
    value = json.loads(raw, object_pairs_hook=unique)
    fields = {
        "version",
        "psql",
        "service",
        "apiKey",
        "signingKey",
        "backendCa",
        "databaseCa",
        "backendOrigin",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise ValueError("issuer settings refused")
    executable = Path(value["psql"])
    ancestry(executable.parent)
    info = executable.lstat()
    if (
        executable.resolve(strict=True) != executable
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid not in (0, os.geteuid())
        or info.st_mode & 0o022
        or not info.st_mode & 0o100
    ):
        raise ValueError("psql executable refused")
    origin = value["backendOrigin"]
    if (
        not isinstance(origin, str)
        or len(origin) > 2048
        or any(ord(c) < 33 or ord(c) > 126 for c in origin)
    ):
        raise ValueError("backend origin refused")
    url = urlsplit(origin)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path
        or (url.port is not None and not 1 <= url.port <= 65535)
    ):
        raise ValueError("backend TLS origin refused")
    ini = configparser.ConfigParser(interpolation=None, strict=True)
    ini.read_string(source(value["service"]).decode("utf8"))
    required = {
        "host",
        "port",
        "dbname",
        "user",
        "password",
        "sslmode",
        "sslrootcert",
        "connect_timeout",
    }
    if (
        ini.defaults()
        or ini.sections() != [SERVICE]
        or set(ini[SERVICE]) != required
        or ini[SERVICE]["sslmode"] != "verify-full"
        or ini[SERVICE]["connect_timeout"] != "5"
    ):
        raise ValueError("database TLS service refused")
    if (
        any(
            not ini[SERVICE][k] or "\n" in ini[SERVICE][k] or "\r" in ini[SERVICE][k]
            for k in required
        )
        or not ini[SERVICE]["port"].isdigit()
        or not 1 <= int(ini[SERVICE]["port"]) <= 65535
    ):
        raise ValueError("database setting refused")
    hostname = ini[SERVICE]["host"]
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if (
            len(hostname) > 253
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", hostname)
            or any(
                not part or len(part) > 63 or part.startswith("-") or part.endswith("-")
                for part in hostname.split(".")
            )
        ):
            raise ValueError("database host refused")
    else:
        if str(address) != hostname:
            raise ValueError("canonical database address required")
    if ini[SERVICE]["sslrootcert"] != value["databaseCa"]["path"]:
        raise ValueError("database CA binding refused")
    for name in ("backendCa", "databaseCa"):
        ssl.create_default_context(cadata=source(value[name], 65536).decode("ascii"))
    return value


@contextlib.contextmanager
def database_snapshot(settings):
    # libpq opens files itself. Never hand it a previously verified mutable
    # operator path: pin exact SHA-checked bytes for this one subprocess.
    service = source(settings["service"])
    ca = source(settings["databaseCa"], 65536)
    original = configparser.ConfigParser(interpolation=None, strict=True)
    original.read_string(service.decode("utf8"))
    if (
        original.defaults()
        or original.sections() != [SERVICE]
        or original[SERVICE].get("sslmode") != "verify-full"
        or original[SERVICE].get("sslrootcert") != settings["databaseCa"]["path"]
    ):
        raise ValueError("database snapshot refused")
    parent = Path(settings["service"]["path"]).parent
    ancestry(parent)
    with tempfile.TemporaryDirectory(
        prefix=".axiom-local-custody-transport-", dir=parent
    ) as name:
        root = Path(name)
        root.chmod(0o700)
        ca_path, service_path = root / "database-ca.pem", root / "service.conf"
        create(ca_path, ca)
        # Keep every original field and byte except the reviewed CA path.
        pinned, count = re.subn(
            rb"(?mi)^(\s*sslrootcert[ \t]*=[ \t]*)[^\r\n]*(\r?)$",
            lambda match: match[1] + str(ca_path).encode("utf8") + match[2],
            service,
        )
        if count != 1:
            raise ValueError("database CA field refused")
        parsed = configparser.ConfigParser(interpolation=None, strict=True)
        parsed.read_string(pinned.decode("utf8"))
        expected = dict(original[SERVICE])
        expected["sslrootcert"] = str(ca_path)
        if (
            parsed.defaults()
            or parsed.sections() != [SERVICE]
            or dict(parsed[SERVICE]) != expected
        ):
            raise ValueError("database snapshot settings changed")
        create(service_path, pinned)
        yield str(service_path)


def database(settings: dict, operation: str, raw: bytes, expected: str, v: dict):
    with database_snapshot(settings) as snapshot_service:
        return database_pinned(settings, snapshot_service, operation, raw, expected, v)


def database_pinned(
    settings: dict,
    snapshot_service: str,
    operation: str,
    raw: bytes,
    expected: str,
    v: dict,
):
    # All variable SQL is validated UUID/hex or base64. No token, API key,
    # password or signing key enters SQL, argv or environment.
    if operation == "status":
        stmt = f"controller_security.local_custody_credential_status('{v['credentialId']}','{v['tenantId']}','{expected}')"
    else:
        if operation not in ("issue", "revoke"):
            raise ValueError("database operation refused")
        body = base64.b64encode(raw).decode("ascii")
        stmt = f"controller_security.{operation}_local_custody_credential(convert_from(decode('{body}','base64'),'UTF8'),'{expected}')"
    sql = f"begin; set local role axiom_local_custody_issuer; set local statement_timeout='5s'; set local lock_timeout='3s'; select {stmt}; commit;"
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/nonexistent",
        "LC_ALL": "C",
        "PGSERVICEFILE": snapshot_service,
        "PGSYSCONFDIR": "/nonexistent",
        "PGPASSFILE": "/nonexistent",
        "PGGSSENCMODE": "disable",
    }
    args = [
        settings["psql"],
        "-X",
        "-q",
        "-w",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "--dbname=service=" + SERVICE,
    ]
    # Input is bounded canonical metadata, output is bounded even if the server/CLI misbehaves.
    payload = sql.encode()
    if len(payload) > 32768:
        raise ValueError("database input refused")
    with subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    ) as child:  # nosec B603 - psql path from validated settings, all flags constant, no shell
        try:
            data = bytearray()
            offset = 0
            end = time.monotonic() + 10
            if child.stdin is None or child.stdout is None:
                raise ValueError("database operation refused")
            os.set_blocking(child.stdin.fileno(), False)
            with selectors.DefaultSelector() as poll:
                poll.register(child.stdin, selectors.EVENT_WRITE)
                poll.register(child.stdout, selectors.EVENT_READ)
                while poll.get_map():
                    remaining = end - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("database deadline")
                    events = poll.select(remaining)
                    if not events:
                        raise TimeoutError("database deadline")
                    for key, _ in events:
                        if key.fileobj is child.stdin:
                            offset += os.write(child.stdin.fileno(), payload[offset:])
                            if offset == len(payload):
                                poll.unregister(child.stdin)
                                child.stdin.close()
                        else:
                            chunk = os.read(child.stdout.fileno(), 4096)
                            if not chunk:
                                poll.unregister(child.stdout)
                            data.extend(chunk)
                            if len(data) > 16384:
                                raise ValueError("database output refused")
            remaining = end - time.monotonic()
            if remaining <= 0 or child.wait(timeout=remaining) != 0 or not data:
                raise ValueError("database operation refused or uncertain")
            return json.loads(data, object_pairs_hook=unique)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()


def checked_receipt(value):
    fields = {
        "version",
        "state",
        "credentialId",
        "tenantId",
        "policyId",
        "policySha256",
        "activationEventId",
        "activationEpoch",
        "configurationSha256",
        "workloadId",
        "principalKind",
        "servicePrincipal",
        "operatorId",
        "issuanceSha256",
        "predecessorId",
        "issuedAt",
        "expiresAt",
        "status",
        "revokedAt",
        "revocationSha256",
        "issuanceReceipt",
        "revocationReceipt",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or type(value["version"]) is not int
        or value["version"] != 1
        or value["state"] != "recorded"
    ):
        raise ValueError("registry receipt refused")
    for key in (
        "credentialId",
        "tenantId",
        "policyId",
        "activationEventId",
        "workloadId",
    ):
        identifier(value[key])
    for key in ("policySha256", "configurationSha256", "issuanceSha256"):
        digest(value[key])
    for key in ("operatorId", "predecessorId"):
        if value[key] is not None:
            identifier(value[key])
    for key in ("activationEpoch", "issuedAt", "expiresAt"):
        integer(value[key])
    if (
        not 1 <= value["expiresAt"] - value["issuedAt"] <= 86400
        or value["principalKind"] not in ("operator", "producer", "controller")
        or (value["principalKind"] == "operator") != (value["operatorId"] is not None)
        or not isinstance(value["servicePrincipal"], str)
        or not 1 <= len(value["servicePrincipal"]) <= 2048
        or value["status"] not in ("active", "expired", "revoked")
    ):
        raise ValueError("registry authority refused")

    def ledger(item):
        if (
            not isinstance(item, dict)
            or set(item) != {"id", "entryHash"}
            or not isinstance(item["id"], str)
            or not re.fullmatch(r"[1-9][0-9]{0,18}", item["id"])
            or int(item["id"]) > 9223372036854775807
        ):
            raise ValueError("registry ledger receipt refused")
        digest(item["entryHash"])

    ledger(value["issuanceReceipt"])
    if value["status"] == "revoked":
        if (
            not isinstance(value["revokedAt"], str)
            or not 1 <= len(value["revokedAt"]) <= 100
        ):
            raise ValueError("revocation refused")
        digest(value["revocationSha256"])
        ledger(value["revocationReceipt"])
    elif any(
        value[key] is not None
        for key in ("revokedAt", "revocationSha256", "revocationReceipt")
    ):
        raise ValueError("revocation state refused")
    return value


def receipt(value, reviewed, expected, *, revoked=False):
    value = checked_receipt(value)
    keys = (
        ("credentialId", "tenantId")
        if revoked
        else (
            "credentialId",
            "tenantId",
            "policyId",
            "policySha256",
            "activationEventId",
            "activationEpoch",
            "configurationSha256",
            "workloadId",
            "principalKind",
            "servicePrincipal",
            "operatorId",
            "predecessorId",
            "issuedAt",
            "expiresAt",
        )
    )
    if (
        any(value[key] != reviewed[key] for key in keys)
        or value["issuanceSha256"]
        != (reviewed["issuanceSha256"] if revoked else expected)
        or (
            revoked
            and (value["status"] != "revoked" or value["revocationSha256"] != expected)
        )
    ):
        raise ValueError("registry commitment refused")
    return value


def credential(reviewed, settings):
    key = source(settings["signingKey"]).removesuffix(b"\n").removesuffix(b"\r")
    if not 32 <= len(key) <= 8192 or any(c < 33 or c > 126 for c in key):
        raise ValueError("signing key refused")
    api = (
        source(settings["apiKey"], 4096)
        .decode("ascii")
        .removesuffix("\n")
        .removesuffix("\r")
    )
    parts, header, claims, signature = _files.jwt_parts(api)
    if (
        header != {"alg": "HS256", "typ": "JWT"}
        or claims.get("role") != "anon"
        or type(claims.get("exp")) is not int
        or claims["exp"] <= time.time()
        or not hmac.compare_digest(
            signature, hmac.digest(key, ".".join(parts[:2]).encode(), "sha256")
        )
    ):
        raise ValueError("gateway signing authority refused")
    payload = {
        "role": ROLE,
        "sub": reviewed["credentialId"],
        "tenant_id": reviewed["tenantId"],
        "workload_id": reviewed["workloadId"],
        "principal_kind": reviewed["principalKind"],
        "service_principal": reviewed["servicePrincipal"],
        "configuration_sha256": reviewed["configurationSha256"],
        "iat": reviewed["issuedAt"],
        "exp": min(reviewed["expiresAt"], reviewed["issuedAt"] + 3600),
    }

    def b64(value):
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    unsigned = ".".join(
        b64(canonical(value)) for value in ({"alg": "HS256", "typ": "JWT"}, payload)
    )
    token = unsigned + "." + b64(hmac.digest(key, unsigned.encode(), "sha256"))
    return canonical({"schemaVersion": 1, "apiKey": api, "accessToken": token})


PROBE_FIELDS = (
    "credentialId",
    "tenantId",
    "workloadId",
    "principalKind",
    "servicePrincipal",
    "operatorId",
    "configurationSha256",
    "issuanceSha256",
    "issuedAt",
    "expiresAt",
)


def probe(settings, data: bytes, accepted):
    bundle = json.loads(data, object_pairs_hook=unique)
    context = ssl.create_default_context(
        cadata=source(settings["backendCa"], 65536).decode("ascii")
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            raise ValueError("backend redirect refused")

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        NoRedirect(),
        urllib.request.HTTPSHandler(context=context),
    )
    query = urllib.request.Request(
        settings["backendOrigin"]
        + "/rest/v1/rpc/read_local_custody_credential_identity",
        data=b"{}",
        method="POST",
        headers={
            "apikey": bundle["apiKey"],
            "Authorization": "Bearer " + bundle["accessToken"],
            "Content-Type": "application/json",
        },
    )
    with _files.deadline(10), opener.open(query, timeout=5) as response:
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            raise ValueError("backend identity refused")
        result = json.loads(raw.decode("utf8"), object_pairs_hook=unique)
    expected = {"version": 1, **{key: accepted[key] for key in PROBE_FIELDS}}
    if (
        result != expected
        or set(result) != set(expected)
        or type(result.get("version")) is not int
    ):
        raise ValueError("backend identity mismatch")


def prepared(review, expected, settings_path, settings_sha, kind):
    raw = read(review, MAX_BYTES)
    value = request(raw, expected, kind)
    settings = configuration(settings_path, settings_sha)
    return raw, value, settings


def check_inputs(review, raw, settings_path, settings_sha, settings):
    if (
        read(review, MAX_BYTES) != raw
        or configuration(settings_path, settings_sha) != settings
    ):
        raise ValueError("issuer inputs changed")


def file_binding(path: Path, expected: bytes, previous=None):
    """Protected bytes plus stable inode/path, never a publication lease."""
    before = path.lstat()
    binding = (
        before.st_dev,
        before.st_ino,
        before.st_uid,
        before.st_mode,
        before.st_nlink,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )
    if previous is not None and binding != previous:
        raise ValueError("output identity changed")
    if read(path, max(len(expected), 1)) != expected:
        raise ValueError("output bytes changed")
    after = path.lstat()
    if binding != (
        after.st_dev,
        after.st_ino,
        after.st_uid,
        after.st_mode,
        after.st_nlink,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ):
        raise ValueError("output changed during verification")
    return binding


def output_directory_binding(target: Path):
    ancestry(target)
    info = target.lstat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("output directory changed")
    return info.st_dev, info.st_ino


def issue(
    review: Path,
    expected: str,
    settings_path: Path,
    settings_sha: str,
    target: Path,
    *,
    resume=False,
    db=database,
    backend=probe,
):
    global PHASE
    PHASE = "configuration"
    raw, value, settings = prepared(
        review, expected, settings_path, settings_sha, "issue"
    )
    # Registry may retain24h, but every originally signed bearer is <=1h. Resume
    # never moves issuedAt/exp forward or silently mints a replacement lease.
    if (
        value["issuedAt"] > time.time()
        or min(value["expiresAt"], value["issuedAt"] + 3600) <= time.time() + 60
    ):
        raise ValueError("original issue window refused")
    PHASE = "signing"
    data = credential(value, settings)
    intent = canonical(
        {
            "version": 1,
            "requestSha256": expected,
            "settingsSha256": settings_sha,
            "deploymentBindingSha256": value["configurationSha256"],
            "credentialSha256": sha(data),
        }
    )
    PHASE = "protected-intent"
    with directory(target, not resume):
        if not resume:
            create(target / "request.json", raw)
            create(target / "candidate.key", data)
            create(target / "intent.json", intent)
        target_identity = output_directory_binding(target)
        names = {p.name for p in target.iterdir()}
        if names not in (
            {"lock", "request.json", "candidate.key", "intent.json"},
            {"lock", "request.json", "candidate.key", "backend.key", "intent.json"},
            {"lock", "request.json", "backend.key", "intent.json"},
            {"lock", "request.json", "backend.key", "intent.json", "ready.json"},
        ):
            raise ValueError("partial issuance output refused")
        saved = "backend.key" if "backend.key" in names else "candidate.key"
        if (
            read(target / "request.json", MAX_BYTES) != raw
            or read(target / "intent.json") != intent
            or read(target / saved) != data
        ):
            raise ValueError("issuance intent changed")
        expected_files = {"request.json": raw, "intent.json": intent, saved: data}
        if "candidate.key" in names:
            expected_files["candidate.key"] = data
        if "ready.json" in names:
            expected_files["ready.json"] = read(target / "ready.json", MAX_BYTES)
        bindings = {
            name: file_binding(target / name, content)
            for name, content in expected_files.items()
        }
        lock_info = (target / "lock").lstat()
        lock_identity = (
            lock_info.st_dev,
            lock_info.st_ino,
            lock_info.st_uid,
            lock_info.st_mode,
            lock_info.st_nlink,
        )

        def check_outputs(expected_names):
            if (
                output_directory_binding(target) != target_identity
                or {p.name for p in target.iterdir()} != expected_names
            ):
                raise ValueError("output paths changed")
            info = (target / "lock").lstat()
            if (
                info.st_dev,
                info.st_ino,
                info.st_uid,
                info.st_mode,
                info.st_nlink,
            ) != lock_identity:
                raise ValueError("output lock changed")
            for name, content in expected_files.items():
                file_binding(target / name, content, bindings[name])

        PHASE = "registry"
        result = receipt(db(settings, "issue", raw, expected, value), value, expected)
        if result["status"] != "active":
            raise ValueError("credential not active")
        PHASE = "postgrest-identity"
        backend(settings, data, result)
        PHASE = "registry-recheck"
        final = receipt(db(settings, "status", raw, expected, value), value, expected)
        if final != result or final["status"] != "active":
            raise ValueError("registry changed")
        PHASE = "input-recheck"
        check_inputs(review, raw, settings_path, settings_sha, settings)
        if credential(value, settings) != data:
            raise ValueError("signing inputs changed")
        PHASE = "publication"
        check_outputs(names)
        if "backend.key" not in names:
            # Exclusive creation cannot overwrite a destination that appears
            # concurrently. Publish the verified memory bytes, never rename a
            # mutable earlier file into authority.
            create(target / "backend.key", data)
            expected_files["backend.key"] = data
            bindings["backend.key"] = file_binding(target / "backend.key", data)
            names.add("backend.key")
        if "candidate.key" in names:
            check_outputs(names)
            (target / "candidate.key").unlink()
            sync(target)
            names.remove("candidate.key")
            expected_files.pop("candidate.key")
            bindings.pop("candidate.key")
        check_outputs(names)
        ready = canonical(
            {
                "version": 1,
                "state": "identity_probe_verified",
                "settingsSha256": settings_sha,
                "credentialSha256": sha(data),
                "registry": result,
                "policyExecutionReadiness": "not_verified",
            }
        )
        if "ready.json" in names:
            if read(target / "ready.json", MAX_BYTES) != ready:
                raise ValueError("completion receipt changed")
        else:
            create(target / "ready.json", ready)
    return result


def revoke(
    review: Path,
    expected: str,
    settings_path: Path,
    settings_sha: str,
    target: Path,
    *,
    resume=False,
    db=database,
):
    global PHASE
    PHASE = "revocation-configuration"
    raw, value, settings = prepared(
        review, expected, settings_path, settings_sha, "revoke"
    )
    intent = canonical(
        {"version": 1, "requestSha256": expected, "settingsSha256": settings_sha}
    )
    with directory(target, not resume):
        if not resume:
            create(target / "request.json", raw)
            create(target / "intent.json", intent)
        target_identity = output_directory_binding(target)
        names = {p.name for p in target.iterdir()}
        if names not in (
            {"lock", "request.json", "intent.json"},
            {"lock", "request.json", "intent.json", "ready.json"},
        ):
            raise ValueError("revocation output refused")
        if (
            read(target / "request.json", MAX_BYTES) != raw
            or read(target / "intent.json") != intent
        ):
            raise ValueError("revocation intent changed")
        expected_files = {"request.json": raw, "intent.json": intent}
        if "ready.json" in names:
            expected_files["ready.json"] = read(target / "ready.json", MAX_BYTES)
        bindings = {
            name: file_binding(target / name, content)
            for name, content in expected_files.items()
        }
        lock_info = (target / "lock").lstat()
        lock_identity = (
            lock_info.st_dev,
            lock_info.st_ino,
            lock_info.st_uid,
            lock_info.st_mode,
            lock_info.st_nlink,
        )
        PHASE = "revocation-registry"
        result = receipt(
            db(settings, "revoke", raw, expected, value), value, expected, revoked=True
        )
        final = receipt(
            db(settings, "status", raw, value["issuanceSha256"], value),
            value,
            expected,
            revoked=True,
        )
        if final != result:
            raise ValueError("revocation reconciliation changed")
        check_inputs(review, raw, settings_path, settings_sha, settings)
        if (
            output_directory_binding(target) != target_identity
            or {p.name for p in target.iterdir()} != names
        ):
            raise ValueError("revocation output paths changed")
        info = (target / "lock").lstat()
        if (
            info.st_dev,
            info.st_ino,
            info.st_uid,
            info.st_mode,
            info.st_nlink,
        ) != lock_identity:
            raise ValueError("revocation output lock changed")
        for name, content in expected_files.items():
            file_binding(target / name, content, bindings[name])
        ready = canonical(result)
        if "ready.json" in names:
            if read(target / "ready.json", MAX_BYTES) != ready:
                raise ValueError("revocation receipt changed")
        else:
            create(target / "ready.json", ready)
    return result


def status(
    review: Path,
    expected: str,
    settings_path: Path,
    settings_sha: str,
    target: Path,
    *,
    db=database,
):
    global PHASE
    PHASE = "status"
    raw, value, settings = prepared(
        review, expected, settings_path, settings_sha, "issue"
    )
    result = receipt(db(settings, "status", raw, expected, value), value, expected)
    check_inputs(review, raw, settings_path, settings_sha, settings)
    # Explicit new protected snapshot, never rewriting an old ready marker.
    create(target, canonical(result))
    return result


def main():
    if (
        not sys.flags.isolated
        or sys.platform not in ("linux", "darwin")
        or len(sys.argv) != 7
        or sys.argv[1]
        not in ("--issue", "--resume-issue", "--revoke", "--resume-revoke", "--status")
    ):
        raise ValueError("explicit isolated issuer command required")
    os.umask(0o077)
    mode, review, expected, settings, settings_sha, target = sys.argv[1:]
    args = (Path(review), expected, Path(settings), settings_sha, Path(target))
    if mode == "--status":
        status(*args)
    else:
        fn = issue if mode.endswith("issue") else revoke
        fn(*args, resume=mode.startswith("--resume"))
    print(
        "Reviewed local credential operation verified; private output retained. Runtime activation remains separate."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - CLI boundary must never expose operator secrets or raw transport errors.
        print(
            "Local credential operation refused or uncertain at "
            + PHASE
            + "; preserve protected intent and reconcile the exact original request. No automatic retry.",
            file=sys.stderr,
        )
        sys.exit(1)
