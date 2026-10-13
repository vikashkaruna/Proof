#!/usr/bin/env python3
"""Produce a protected manifest v1 at backup time; never activate a scheduler.

Execution against real data requires approved credentials, target and destination.
A local path/region argument does not establish host or backup-storage residency.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import hmac
import importlib
import json
import os
import re
import select
import shutil
import stat
import subprocess  # nosec B404
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, NoReturn, Protocol, Self, cast
from urllib.parse import urlparse

HASH = re.compile(r"[0-9a-f]{64}\Z")
NAME = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")
SNAPSHOT = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+\Z")
MAX_OBJECTS = 100000
MAX_OBJECT_BYTES = 67108864
MAX_INVENTORY_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024


class BackupRefused(RuntimeError):
    """Only a bounded machine code may leave an adapter boundary."""


def refuse(code: str) -> NoReturn:
    raise BackupRefused(code)


def record(value: object, keys: set[str] | None = None) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        refuse("invalid_record")
    result = cast(dict[str, object], value)
    if keys is not None and set(result) != keys:
        refuse("invalid_record")
    return result


def text(value: object, maximum: int = 1024) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode()) > maximum
        or "\x00" in value
    ):
        refuse("invalid_text")
    return value


def integer(value: object, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        refuse("invalid_count")
    return value


def timestamp(value: object) -> datetime:
    try:
        parsed = (
            value
            if isinstance(value, datetime)
            else datetime.fromisoformat(text(value))
        )
        if parsed.tzinfo is None:
            refuse("invalid_timestamp")
        return parsed.astimezone(UTC)
    except (ValueError, OverflowError):
        raise BackupRefused("invalid_timestamp") from None


def private_regular(path: Path) -> None:
    try:
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o077
            or info.st_uid != os.getuid()
        ):
            refuse("unsafe_private_file")
        if any(p.is_symlink() for p in (path, *path.parents)):
            refuse("unsafe_private_file")
    except OSError:
        raise BackupRefused("unsafe_private_file") from None


def secure_open(path: Path) -> BinaryIO:
    return os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb"
    )


def digest_file(path: Path) -> tuple[str, int]:
    private_regular(path)
    digest, size = hashlib.sha256(), 0
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_no_replace(source: Path, destination: Path) -> None:
    """Atomic directory publication, including an existing empty destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        fn = libc.renamex_np
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        result = fn(os.fsencode(source), os.fsencode(destination), 4)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        fn = libc.renameat2
        fn.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        fn.restype = ctypes.c_int
        result = fn(
            -100, os.fsencode(source), -100, os.fsencode(destination), 1
        )  # RENAME_NOREPLACE
    else:
        refuse("atomic_publication_unavailable")
    if result != 0:
        code = ctypes.get_errno()
        refuse(
            "backup_destination_exists"
            if code in (errno.EEXIST, errno.ENOTEMPTY)
            else "atomic_publication_failed"
        )


@dataclass(frozen=True)
class Config:
    database: str
    bucket: str
    output: Path
    pg_env: Mapping[str, str] = field(repr=False)
    manifest_key: str = field(repr=False)
    region: str
    endpoint: str | None
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)
    session_token: str | None = field(default=None, repr=False)

    @classmethod
    def from_environment(cls, env: Mapping[str, str]) -> Config:
        database = env.get("PGDATABASE", "")
        bucket = env.get("AXIOM_BACKUP_SOURCE_BUCKET", "")
        key = env.get("AXIOM_RECOVERY_MANIFEST_KEY", "")
        if not NAME.fullmatch(database) or database == "postgres":
            refuse("application_database_required")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            refuse("source_bucket_required")
        if not HASH.fullmatch(key) or key == "0" * 64:
            refuse("manifest_authority_required")
        for name in (
            "APPROVAL_SIGNING_KEY",
            "AXIOM_MFA_ENCRYPTION_KEY",
            "SUPABASE_SERVICE_KEY",
            "AGENT_RUNTIME_INTERNAL_TOKEN",
            "MODEL_GATEWAY_API_KEY",
            "AXIOM_STORAGE_SECRET_ACCESS_KEY",
            "AXIOM_RECOVERY_STORAGE_SECRET_ACCESS_KEY",
            "AXIOM_BACKUP_STORAGE_SECRET_ACCESS_KEY",
        ):
            candidate = env.get(name)
            if candidate:
                same = hmac.compare_digest(key.encode(), candidate.encode())
                if re.fullmatch(r"[0-9a-fA-F]{64}", candidate):
                    same = same or hmac.compare_digest(
                        bytes.fromhex(key), bytes.fromhex(candidate)
                    )
                if same:
                    refuse("manifest_authority_not_distinct")
        if not all(
            env.get(name)
            for name in (
                "PGHOST",
                "PGPORT",
                "PGUSER",
                "PGPASSFILE",
                "AXIOM_BACKUP_OUTPUT",
                "AXIOM_BACKUP_STORAGE_ACCESS_KEY_ID",
                "AXIOM_BACKUP_STORAGE_SECRET_ACCESS_KEY",
            )
        ):
            refuse("explicit_backup_configuration_required")
        if (
            len(env["PGPORT"]) > 5
            or not env["PGPORT"].isascii()
            or not env["PGPORT"].isdigit()
            or not 1 <= int(env["PGPORT"]) <= 65535
        ):
            refuse("invalid_postgres_port")
        # Credentials live in a protected passfile, never connection argv.
        private_regular(Path(env["PGPASSFILE"]))
        host = env["PGHOST"]
        local = host in ("localhost", "127.0.0.1", "::1")
        if host.startswith("/"):
            socket = Path(host)
            if not socket.is_dir() or any(
                p.is_symlink() for p in (socket, *socket.parents)
            ):
                refuse("unsafe_postgres_socket")
            socket_info = socket.stat()
            if (
                socket_info.st_uid not in (0, os.getuid())
                or socket_info.st_mode & 0o022
            ):
                refuse("unsafe_postgres_socket")
            local = True
        elif not re.fullmatch(r"[A-Za-z0-9.:-]{1,253}", host):
            refuse("invalid_postgres_host")
        ssl_mode = env.get("PGSSLMODE", "disable" if local else "")
        if ssl_mode not in ("disable", "verify-full") or (
            not local and ssl_mode != "verify-full"
        ):
            refuse("verified_postgres_transport_required")
        if ssl_mode == "verify-full":
            if not env.get("PGSSLROOTCERT"):
                refuse("protected_postgres_ca_required")
            private_regular(Path(env["PGSSLROOTCERT"]))
        output = Path(env["AXIOM_BACKUP_OUTPUT"])
        if not output.is_absolute() or any(
            p.is_symlink() for p in (output, *output.parents)
        ):
            refuse("unsafe_output_directory")
        info = output.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_mode & 0o077
            or info.st_uid != os.getuid()
        ):
            refuse("unsafe_output_directory")
        region = env.get("AXIOM_BACKUP_SOURCE_REGION", "")
        if region not in ("ap-south-1", "asia-south1"):
            refuse("mumbai_region_required")
        endpoint = env.get("AXIOM_BACKUP_S3_ENDPOINT") or None
        if region == "asia-south1" and endpoint is None:
            refuse("explicit_gcp_storage_endpoint_required")
        if endpoint:
            parsed = urlparse(endpoint)
            if (
                parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in ("", "/")
                or (
                    parsed.scheme != "https"
                    and not (
                        parsed.scheme == "http"
                        and parsed.hostname in ("minio", "localhost", "127.0.0.1")
                    )
                )
                or not parsed.hostname
            ):
                refuse("invalid_storage_endpoint")
        pg_env = {
            name: env[name]
            for name in ("PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSFILE")
        }
        pg_env["PGSSLMODE"] = ssl_mode
        if ssl_mode == "verify-full":
            pg_env["PGSSLROOTCERT"] = env["PGSSLROOTCERT"]
        pg_env.update(
            {
                "PATH": env.get("PATH", os.defpath),
                "PGCONNECT_TIMEOUT": "15",
                "PGAPPNAME": "axiom-scheduled-backup",
                "PGOPTIONS": "-c default_transaction_read_only=on",
            }
        )
        return cls(
            database,
            bucket,
            output,
            pg_env,
            key,
            region,
            endpoint,
            env["AXIOM_BACKUP_STORAGE_ACCESS_KEY_ID"],
            env["AXIOM_BACKUP_STORAGE_SECRET_ACCESS_KEY"],
            env.get("AXIOM_BACKUP_STORAGE_SESSION_TOKEN"),
        )


class SnapshotPort(Protocol):
    backup_at: str

    def __enter__(self) -> Self: ...
    def __exit__(self, *args: object) -> None: ...
    def inventory(self) -> dict[str, object]: ...
    def dump(self, path: Path) -> None: ...


class PostgresSnapshot:
    def __init__(self, config: Config):
        self.config = config
        self.process: subprocess.Popen[bytes] | None = None
        self.buffer = b""
        self.backup_at = ""
        self.snapshot_id = ""

    def line(self, limit: int) -> bytes:
        if self.process is None or self.process.stdout is None:
            refuse("snapshot_connection_unavailable")
        deadline = time.monotonic() + 60
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if (
                remaining <= 0
                or not select.select([self.process.stdout], [], [], remaining)[0]
            ):
                refuse("snapshot_query_timeout")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                refuse("snapshot_protocol_failed")
            self.buffer += chunk
            if len(self.buffer) > limit:
                refuse("snapshot_response_too_large")
        line, self.buffer = self.buffer.split(b"\n", 1)
        return line

    def query(self, sql: str, limit: int = MAX_INVENTORY_BYTES) -> object:
        if self.process is None or self.process.stdin is None:
            refuse("snapshot_connection_unavailable")
        marker = "axiom_end_" + uuid.uuid4().hex
        try:
            self.process.stdin.write((sql + "\n\\echo " + marker + "\n").encode())
            self.process.stdin.flush()
            value = self.line(limit)
            if self.line(256) != marker.encode():
                refuse("snapshot_protocol_failed")
            return cast(object, json.loads(value))
        except (OSError, ValueError):
            raise BackupRefused("snapshot_protocol_failed") from None

    def __enter__(self) -> Self:
        executable = shutil.which("psql", path=self.config.pg_env["PATH"])
        if not executable:
            refuse("postgres_tools_unavailable")
        self.process = subprocess.Popen(  # nosec B603
            [executable, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(self.config.pg_env),
        )
        try:
            result = record(
                self.query(
                    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL TIME ZONE 'UTC'; SELECT json_build_object('database',current_database(),'backupAt',transaction_timestamp(),'snapshot',pg_export_snapshot());",
                    16384,
                ),
                {"database", "backupAt", "snapshot"},
            )
            if result["database"] != self.config.database:
                refuse("snapshot_database_mismatch")
            self.backup_at = timestamp(result["backupAt"]).isoformat()
            self.snapshot_id = text(result["snapshot"])
            if not SNAPSHOT.fullmatch(self.snapshot_id):
                refuse("invalid_snapshot_identity")
            return self
        except BaseException:
            self.__exit__()
            raise

    def inventory(self) -> dict[str, object]:
        metadata = record(
            self.query(
                "SELECT json_build_object('tableCount',(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'),'rlsCount',(select count(*) from pg_tables where schemaname='public' and rowsecurity),'ledgerFingerprint',(select count(*)::text||':'||encode(digest(coalesce(string_agg(row_to_json(a)::text,E'\\n' order by tenant_id,sequence_no),''),'sha256'),'hex') from public.audit_ledger a),'ledgerBreaks',(select count(*) from (select distinct tenant_id from public.audit_ledger)t where exists(select 1 from public.verify_ledger(t.tenant_id))));",
                16384,
            )
        )
        tables = self.query(
            "SELECT coalesce(json_agg(table_name order by table_name),'[]'::json) FROM (select table_name from information_schema.columns where table_schema='public' and column_name in ('bucket','object_key','version_id','content_hash','byte_size') group by table_name having count(distinct column_name)=5)t;",
            16384,
        )
        if (
            not isinstance(tables, list)
            or not 1 <= len(tables) <= 256
            or len(set(map(str, tables))) != len(tables)
        ):
            refuse("version_tables_unavailable")
        names = [text(t) for t in tables]
        if any(not NAME.fullmatch(n) for n in names):
            refuse("invalid_version_table")
        # Catalog identifiers are separately NAME-validated and quoted; no caller SQL.
        union = " union all ".join(
            f'select bucket,object_key,version_id,content_hash,byte_size from public."{n}"'  # nosec B608
            for n in names
        )
        metadata["references"] = self.query(
            "SELECT coalesce(json_agg(json_build_object('bucket',bucket,'key',object_key,'versionId',version_id,'sha256',content_hash,'byteSize',byte_size)),'[]'::json) FROM (SELECT * FROM ("  # nosec B608
            + union
            + ")all_references LIMIT 100001)v;"
        )
        return metadata

    def dump(self, path: Path) -> None:
        executable = shutil.which("pg_dump", path=self.config.pg_env["PATH"])
        if not executable or self.process is None or self.process.poll() is not None:
            refuse("snapshot_connection_unavailable")
        with secure_open(path) as output:
            result = subprocess.run(  # nosec B603
                [executable, "--format=plain", "--snapshot=" + self.snapshot_id],
                env=dict(self.config.pg_env),
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=1800,
                check=False,
            )
            output.flush()
            os.fsync(output.fileno())
        if result.returncode != 0 or self.process.poll() is not None:
            refuse("database_dump_failed")

    def __exit__(self, *args: object) -> None:
        if self.process is not None:
            try:
                if self.process.stdin is not None:
                    self.process.stdin.close()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
            finally:
                if self.process.stdout is not None:
                    self.process.stdout.close()
                self.process = None


class S3Port(Protocol):
    def get_bucket_location(self, *, Bucket: str) -> dict[str, object]: ...
    def get_object_lock_configuration(self, *, Bucket: str) -> dict[str, object]: ...
    def get_object(
        self, *, Bucket: str, Key: str, VersionId: str
    ) -> dict[str, object]: ...
    def get_object_retention(
        self, *, Bucket: str, Key: str, VersionId: str
    ) -> dict[str, object]: ...
    def get_object_legal_hold(
        self, *, Bucket: str, Key: str, VersionId: str
    ) -> dict[str, object]: ...


class Readable(Protocol):
    def read(self, size: int) -> bytes: ...
    def close(self) -> None: ...


def storage_client(config: Config) -> S3Port:
    boto3 = importlib.import_module(
        "boto3"
    )  # Existing locked runtime dependency; no credential discovery.
    transport = importlib.import_module("botocore.config").Config(
        connect_timeout=10,
        read_timeout=30,
        retries={"mode": "standard", "total_max_attempts": 2},
    )
    return cast(
        S3Port,
        boto3.client(
            "s3",
            region_name=config.region,
            endpoint_url=config.endpoint,
            aws_access_key_id=config.access_key,
            aws_secret_access_key=config.secret_key,
            aws_session_token=config.session_token,
            config=transport,
        ),
    )


def references(value: object, bucket: str) -> list[dict[str, object]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_OBJECTS:
        refuse("invalid_evidence_inventory")
    unique: dict[tuple[str, str], dict[str, object]] = {}
    total = 0
    for row in value:
        item = record(row, {"bucket", "key", "versionId", "sha256", "byteSize"})
        key, version = text(item["key"], 1024), text(item["versionId"], 1024)
        size = integer(item["byteSize"], 1, MAX_OBJECT_BYTES)
        if (
            item["bucket"] != bucket
            or not key.startswith("tenants/")
            or version == "null"
            or not HASH.fullmatch(text(item["sha256"], 64))
        ):
            refuse("invalid_evidence_identity")
        identity = (key, version)
        if identity in unique:
            if unique[identity] != item:
                refuse("conflicting_evidence_reference")
            continue
        unique[identity] = item
        total += size
        if total > MAX_TOTAL_BYTES:
            refuse("evidence_inventory_too_large")
    return [unique[k] for k in sorted(unique)]


def copy_version(
    s3: S3Port,
    config: Config,
    item: dict[str, object],
    output: Path,
    backup_at: datetime,
) -> dict[str, object]:
    identity = {
        "Bucket": config.bucket,
        "Key": text(item["key"]),
        "VersionId": text(item["versionId"]),
    }
    retained = record(s3.get_object_retention(**identity).get("Retention"))
    retain_until = timestamp(retained.get("RetainUntilDate"))
    if retained.get("Mode") != "COMPLIANCE" or retain_until <= backup_at:
        refuse("source_version_not_compliance_locked")
    hold = record(s3.get_object_legal_hold(**identity).get("LegalHold"))
    if hold.get("Status") not in ("ON", "OFF"):
        refuse("source_legal_hold_unavailable")
    response = record(s3.get_object(**identity))
    body_object = response.get("Body")
    if not callable(getattr(body_object, "read", None)) or not callable(
        getattr(body_object, "close", None)
    ):
        refuse("source_bytes_unavailable")
    body = cast(Readable, body_object)
    try:
        if (
            response.get("VersionId") != item["versionId"]
            or integer(response.get("ContentLength"), 1, MAX_OBJECT_BYTES)
            != item["byteSize"]
            or response.get("ServerSideEncryption") not in ("AES256", "aws:kms")
        ):
            refuse("source_version_metadata_mismatch")
        digest, size = hashlib.sha256(), 0
        with secure_open(output) as target:
            while True:
                chunk = body.read(1024 * 1024)
                if not isinstance(chunk, bytes) or len(chunk) > 1024 * 1024:
                    refuse("invalid_source_stream")
                if not chunk:
                    break
                size += len(chunk)
                if size > integer(item["byteSize"], 1, MAX_OBJECT_BYTES):
                    refuse("source_size_mismatch")
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        if size != item["byteSize"] or digest.hexdigest() != item["sha256"]:
            refuse("source_bytes_mismatch")
    finally:
        body.close()
    return {
        "path": "objects/" + output.name,
        "key": item["key"],
        "sourceVersionId": item["versionId"],
        "sha256": item["sha256"],
        "byteSize": item["byteSize"],
        "retainUntil": retain_until.isoformat(),
        "legalHold": hold["Status"] == "ON",
    }


def produce(
    config: Config,
    snapshot_factory: Callable[[Config], SnapshotPort] = PostgresSnapshot,
    s3_factory: Callable[[Config], S3Port] = storage_client,
) -> Path:
    staging = Path(tempfile.mkdtemp(prefix=".pending-", dir=config.output))
    os.chmod(staging, 0o700)
    destination = config.output / ("backup-" + uuid.uuid4().hex)
    published = False
    try:
        s3 = s3_factory(config)
        if (
            s3.get_bucket_location(Bucket=config.bucket).get("LocationConstraint")
            != config.region
        ):
            refuse("source_region_mismatch")
        lock = record(
            s3.get_object_lock_configuration(Bucket=config.bucket).get(
                "ObjectLockConfiguration"
            )
        )
        retention = record(record(lock.get("Rule")).get("DefaultRetention"))
        if (
            lock.get("ObjectLockEnabled") != "Enabled"
            or retention.get("Mode") != "COMPLIANCE"
            or not (
                (
                    type(retention.get("Years")) is int
                    and cast(int, retention["Years"]) >= 7
                )
                or (
                    type(retention.get("Days")) is int
                    and cast(int, retention["Days"]) >= 2557
                )
            )
        ):
            refuse("source_bucket_not_compliance_locked")
        with snapshot_factory(config) as snapshot:
            backup_at = timestamp(snapshot.backup_at)
            if backup_at > datetime.now(UTC):
                refuse("snapshot_timestamp_in_future")
            inventory = record(
                snapshot.inventory(),
                {
                    "tableCount",
                    "rlsCount",
                    "ledgerFingerprint",
                    "ledgerBreaks",
                    "references",
                },
            )
            table_count = integer(inventory["tableCount"], 80, 100000)
            rls_count = integer(inventory["rlsCount"], 1, table_count)
            if integer(inventory["ledgerBreaks"], 0, 100000) != 0 or not re.fullmatch(
                r"[0-9]+:[0-9a-f]{64}", text(inventory["ledgerFingerprint"])
            ):
                refuse("source_ledger_invalid")
            items = references(inventory["references"], config.bucket)
            dump = staging / "database.sql"
            snapshot.dump(dump)
            dump_hash, size = digest_file(dump)
            if size < 50000:
                refuse("database_dump_incomplete")
            objects = staging / "objects"
            objects.mkdir(mode=0o700)
            evidence = [
                copy_version(
                    s3, config, item, objects / (str(index) + ".bin"), backup_at
                )
                for index, item in enumerate(items)
            ]
            # Capture can take time: recheck all actual files immediately before signing.
            if digest_file(dump) != (dump_hash, size):
                refuse("captured_database_changed")
            for captured in evidence:
                if digest_file(staging / text(captured["path"])) != (
                    captured["sha256"],
                    captured["byteSize"],
                ):
                    refuse("captured_evidence_changed")
            manifest: dict[str, object] = {
                "schemaVersion": 1,
                "sourceDatabase": config.database,
                "sourceBucket": config.bucket,
                "backupAt": backup_at.isoformat(),
                "database": {
                    "sha256": dump_hash,
                    "byteSize": size,
                    "ledgerFingerprint": inventory["ledgerFingerprint"],
                    "tableCount": table_count,
                    "rlsCount": rls_count,
                },
                "evidence": evidence,
            }
            wire = json.dumps(
                manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
            manifest["signature"] = hmac.new(
                bytes.fromhex(config.manifest_key), wire, hashlib.sha256
            ).hexdigest()
            with secure_open(staging / "manifest.json") as target:
                target.write(json.dumps(manifest, ensure_ascii=False).encode())
                target.flush()
                os.fsync(target.fileno())
            sync_directory(objects)
            sync_directory(staging)
        publish_no_replace(staging, destination)
        published = True
        try:
            sync_directory(config.output)
        except Exception:  # noqa: BLE001 - publication happened; retain it for operator readback
            raise BackupRefused("backup_publication_uncertain") from None
        return destination
    except BackupRefused:
        raise
    except Exception:  # noqa: BLE001 - never expose subprocess/provider/customer exception content
        raise BackupRefused("backup_capture_failed") from None
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    try:
        if len(sys.argv) != 1:
            refuse("arguments_not_supported")
        config = Config.from_environment(os.environ)
        produce(config)
        print(
            "Scheduled backup capture published; schedule, residency, RPO and RTO acceptance remain unverified."
        )
        return 0
    except BackupRefused as error:
        if str(error) == "backup_publication_uncertain":
            print(
                "backup_publication_uncertain: a signed backup was published. Operator readback is required before any new capture or retry.",
                file=sys.stderr,
            )
        else:
            print(
                "Scheduled backup capture refused; protected errors withheld.",
                file=sys.stderr,
            )
        return 1
    except Exception:  # noqa: BLE001 - CLI output must never contain credentials or customer values
        print(
            "Scheduled backup capture refused or uncertain; protected inputs and errors withheld.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
