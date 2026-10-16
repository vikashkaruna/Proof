#!/usr/bin/env python3
"""Hold a disposable SQL transaction until its actual concurrency proof exists.

Only fixture SQL is accepted from the sibling Bash tests. Every Docker client
starts in an owned process group, so a timeout can kill/reap that client's
descendants without touching any other test, container, or desktop process.
"""

from __future__ import annotations

import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

PHASE_TIMEOUT = 90
PROBE_TIMEOUT = 10
SERVER_TIMEOUT_MS = 330_000


class BarrierFailure(RuntimeError):
    """A claimed race did not actually exercise its required ordering."""


def review141_probe_query(contract: str, holder: int, contender: int) -> str | None:
    """Optional phase proof, never interpolating caller SQL or arbitrary names."""
    if not contract.startswith("review141:"):
        return None
    parsed = re.fullmatch(
        r"review141:(tenant|engagement|head):([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})",
        contract,
    )
    if parsed is None or any(
        type(pid) is not int or not 0 < pid < 2**31 for pid in (holder, contender)
    ):
        raise BarrierFailure("Invalid review141 phase contract")
    phase, tenant = parsed.groups()
    head = f"hashtextextended('public-control-review:{tenant}',0)"
    head_match = f"locktype='advisory' and classid=(({head} >> 32) & 4294967295)::oid and objid=({head} & 4294967295)::oid and objsubid=1"
    tenant_match = f"locktype='advisory' and classid=139 and objid=(hashtext('{tenant}')::bigint & 4294967295)::oid and objsubid=2"
    if phase == "tenant":
        holder_phase = f"exists(select 1 from pg_locks where pid={holder} and granted and {tenant_match}) and exists(select 1 from pg_locks where pid={holder} and granted and relation='public.estates'::regclass and mode='RowShareLock') and exists(select 1 from pg_locks where pid={holder} and granted and relation='public.engagements'::regclass and mode='RowShareLock')"
        contender_phase = f"exists(select 1 from pg_locks where pid={contender} and not granted and {tenant_match})"
    elif phase == "engagement":
        holder_phase = f"exists(select 1 from pg_locks where pid={holder} and granted and relation='public.engagements'::regclass and mode='RowShareLock')"
        contender_phase = f"exists(select 1 from pg_locks waiter join pg_locks owner using(transactionid) where waiter.pid={contender} and owner.pid={holder} and waiter.locktype='transactionid' and owner.locktype='transactionid' and not waiter.granted and owner.granted) and exists(select 1 from pg_locks where pid={contender} and granted and relation='public.engagements'::regclass and mode='RowShareLock')"
    else:
        holder_phase = f"exists(select 1 from pg_locks where pid={holder} and granted and {head_match}) and exists(select 1 from pg_locks where pid={holder} and granted and relation='public.engagements'::regclass and mode='RowShareLock')"
        contender_phase = f"exists(select 1 from pg_locks where pid={contender} and not granted and {head_match}) and exists(select 1 from pg_locks where pid={contender} and granted and relation='public.engagements'::regclass and mode='RowShareLock')"
    return f"select jsonb_build_object('phase','{phase}','holder',{holder},'contender',{contender},'blocked_by_holder',{holder}=any(pg_blocking_pids({contender})),'holder_phase',({holder_phase}),'contender_phase',({contender_phase}),'contender_head',exists(select 1 from pg_locks where pid={contender} and granted and {head_match}),'locks',(select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'locktype',locktype,'relation',relation::text,'classid',classid::text,'objid',objid::text,'objsubid',objsubid,'mode',mode,'granted',granted,'transactionid',transactionid::text)),'[]'::jsonb) from pg_locks where pid in ({holder},{contender})))"


def validate_review141_phase(value: object) -> dict:
    """Return only the fixed safe metadata projection produced by our SQL."""
    fields = {
        "phase",
        "holder",
        "contender",
        "blocked_by_holder",
        "holder_phase",
        "contender_phase",
        "contender_head",
        "locks",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value.get("phase") not in {"tenant", "engagement", "head"}
    ):
        raise BarrierFailure("Review141 phase metadata refused")
    if (
        any(
            value.get(k) is not True
            for k in ("blocked_by_holder", "holder_phase", "contender_phase")
        )
        or value.get("contender_head") is not False
    ):
        raise BarrierFailure("Review141 lock order was not established")
    if any(
        type(value.get(k)) is not int or not 0 < value[k] < 2**31
        for k in ("holder", "contender")
    ) or not isinstance(value["locks"], list):
        raise BarrierFailure("Review141 phase metadata refused")
    lock_fields = {
        "pid",
        "locktype",
        "relation",
        "classid",
        "objid",
        "objsubid",
        "mode",
        "granted",
        "transactionid",
    }
    for lock in value["locks"]:
        if (
            not isinstance(lock, dict)
            or set(lock) != lock_fields
            or any(
                isinstance(v, str) and not re.fullmatch(r"[A-Za-z0-9_]*", v)
                for v in lock.values()
            )
        ):
            raise BarrierFailure("Review141 unsafe lock metadata refused")
    return value


def custody145_probe_query(contract: str, holder: int, contender: int) -> str | None:
    """Exact advisory witness; no caller SQL/URLs/credentials in the projection."""
    if not contract.startswith("custody145:"):
        return None
    parsed = re.fullmatch(
        r"custody145:(tenant|credential):([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})",
        contract,
    )
    if parsed is None or any(
        type(pid) is not int or not 0 < pid < 2**31 for pid in (holder, contender)
    ):
        raise BarrierFailure("Invalid custody145 phase contract")
    phase, identity = parsed.groups()
    key = (
        f"hashtextextended('{identity}',47)"
        if phase == "tenant"
        else f"hashtextextended('axiom.local-custody.issue.{identity}',0)"
    )
    match = f"locktype='advisory' and classid=(({key} >> 32) & 4294967295)::oid and objid=({key} & 4294967295)::oid and objsubid=1"
    held = f"exists(select 1 from pg_locks where pid={holder} and granted and {match})"
    waiting = f"exists(select 1 from pg_locks where pid={contender} and not granted and {match})"
    return f"select jsonb_build_object('phase','{phase}','holder',{holder},'contender',{contender},'blocked_by_holder',{holder}=any(pg_blocking_pids({contender})),'holder_phase',({held}),'contender_phase',({waiting}),'locks',(select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'locktype',locktype,'relation',relation::text,'classid',classid::text,'objid',objid::text,'objsubid',objsubid,'mode',mode,'granted',granted,'transactionid',transactionid::text)),'[]'::jsonb) from pg_locks where pid in ({holder},{contender})))"


def validate_custody145_phase(value: object) -> dict:
    fields = {
        "phase",
        "holder",
        "contender",
        "blocked_by_holder",
        "holder_phase",
        "contender_phase",
        "locks",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value.get("phase") not in {"tenant", "credential"}
    ):
        raise BarrierFailure("Custody145 phase metadata refused")
    if any(
        value.get(key) is not True
        for key in ("blocked_by_holder", "holder_phase", "contender_phase")
    ):
        raise BarrierFailure("Custody145 exact advisory contention not established")
    if (
        any(
            type(value.get(key)) is not int or not 0 < value[key] < 2**31
            for key in ("holder", "contender")
        )
        or value["holder"] == value["contender"]
        or not isinstance(value["locks"], list)
    ):
        raise BarrierFailure("Custody145 process metadata refused")
    lock_fields = {
        "pid",
        "locktype",
        "relation",
        "classid",
        "objid",
        "objsubid",
        "mode",
        "granted",
        "transactionid",
    }
    for lock in value["locks"]:
        if (
            not isinstance(lock, dict)
            or set(lock) != lock_fields
            or lock.get("pid") not in {value["holder"], value["contender"]}
            or any(
                isinstance(v, str) and not re.fullmatch(r"[A-Za-z0-9_]*", v)
                for v in lock.values()
            )
        ):
            raise BarrierFailure("Custody145 unsafe lock metadata refused")
    held = [
        lock
        for lock in value["locks"]
        if lock["pid"] == value["holder"]
        and lock["locktype"] == "advisory"
        and lock["granted"] is True
    ]
    waiting = [
        lock
        for lock in value["locks"]
        if lock["pid"] == value["contender"]
        and lock["locktype"] == "advisory"
        and lock["granted"] is False
    ]
    if not any(
        all(owner[k] == waiter[k] for k in ("classid", "objid", "objsubid"))
        and owner["objsubid"] == 1
        for owner in held
        for waiter in waiting
    ):
        raise BarrierFailure("Custody145 exact holder/waiter lock rows missing")
    return value


def custody147_probe_query(contract: str, holder: int, contender: int) -> str | None:
    """Exact147 row wait, including contender tuple lock on retained row CTID.

    Relations and predicates are fixed here, never caller SQL. CTID is read
    only as a transient witness while the original transaction remains held.
    The transactionid wait must be on this exact holder, not any row writer.
    """
    if not contract.startswith("custody147:"):
        return None
    uuid = r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
    engagement = re.fullmatch(r"custody147:engagement:(" + uuid + r")", contract)
    if engagement is not None:
        return review141_probe_query(
            "review141:engagement:" + engagement[1], holder, contender
        )
    match = re.fullmatch(
        r"custody147:row:(membership|user):(" + uuid + r"):(" + uuid + r")", contract
    )
    if (
        match is None
        or any(
            type(pid) is not int or not 0 < pid < 2**31 for pid in (holder, contender)
        )
        or holder == contender
    ):
        raise BarrierFailure("Invalid custody147 row contract")
    kind, tenant, actor = match.groups()
    relation = "tenant_users" if kind == "membership" else "users"
    predicate = (
        f"target.tenant_id='{tenant}'::uuid and target.user_id='{actor}'::uuid"
        if kind == "membership"
        else f"target.id='{actor}'::uuid and exists(select 1 from public.tenant_users m where m.tenant_id='{tenant}'::uuid and m.user_id=target.id)"
    )
    blocked = f"exists(select 1 from pg_locks waiter join pg_locks owner using(transactionid) where waiter.pid={contender} and owner.pid={holder} and waiter.locktype='transactionid' and owner.locktype='transactionid' and not waiter.granted and owner.granted)"
    tuple_lock = f"exists(select 1 from public.{relation} target join pg_locks l on l.pid={contender} and l.locktype='tuple' and l.relation='public.{relation}'::regclass and l.page=split_part(trim(both '()' from target.ctid::text),',',1)::bigint and l.tuple=split_part(trim(both '()' from target.ctid::text),',',2)::integer where {predicate})"
    return f"select jsonb_build_object('phase','row','kind','{kind}','tenant','{tenant}','actor','{actor}','holder',{holder},'contender',{contender},'blocked_by_holder',{holder}=any(pg_blocking_pids({contender})),'transaction_wait',({blocked}),'exact_tuple',({tuple_lock}),'holder_relation',exists(select 1 from pg_locks where pid={holder} and granted and relation='public.{relation}'::regclass and mode in ('RowShareLock','RowExclusiveLock')),'contender_relation',exists(select 1 from pg_locks where pid={contender} and granted and relation='public.{relation}'::regclass and mode in ('RowShareLock','RowExclusiveLock')),'locks',(select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'locktype',locktype,'relation',relation::text,'page',page,'tuple',tuple,'mode',mode,'granted',granted,'transactionid',transactionid::text)),'[]'::jsonb) from pg_locks where pid in ({holder},{contender})))"


def validate_custody147_phase(value: object) -> dict:
    if isinstance(value, dict) and value.get("phase") == "engagement":
        return validate_review141_phase(value)
    fields = {
        "phase",
        "kind",
        "tenant",
        "actor",
        "holder",
        "contender",
        "blocked_by_holder",
        "transaction_wait",
        "exact_tuple",
        "holder_relation",
        "contender_relation",
        "locks",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value.get("phase") != "row"
        or value.get("kind") not in {"membership", "user"}
    ):
        raise BarrierFailure("Custody147 row metadata refused")
    contract = f"custody147:row:{value['kind']}:{value['tenant']}:{value['actor']}"
    custody147_probe_query(contract, value["holder"], value["contender"])
    if any(
        value[k] is not True
        for k in (
            "blocked_by_holder",
            "transaction_wait",
            "exact_tuple",
            "holder_relation",
            "contender_relation",
        )
    ) or not isinstance(value["locks"], list):
        raise BarrierFailure("Custody147 exact row wait missing")
    allowed = {
        "pid",
        "locktype",
        "relation",
        "page",
        "tuple",
        "mode",
        "granted",
        "transactionid",
    }
    for lock in value["locks"]:
        if (
            not isinstance(lock, dict)
            or set(lock) != allowed
            or lock.get("pid") not in {value["holder"], value["contender"]}
            or any(
                isinstance(v, str) and not re.fullmatch(r"[A-Za-z0-9_]*", v)
                for v in lock.values()
            )
        ):
            raise BarrierFailure("Custody147 unsafe row metadata refused")
    if not any(
        l["pid"] == value["contender"] and l["locktype"] == "tuple"
        for l in value["locks"]
    ):
        raise BarrierFailure("Custody147 contender tuple metadata missing")
    if not any(
        l["pid"] == value["contender"]
        and l["locktype"] == "transactionid"
        and l["granted"] is False
        for l in value["locks"]
    ):
        raise BarrierFailure("Custody147 contender transaction metadata missing")
    owners = {
        lock["transactionid"]
        for lock in value["locks"]
        if lock["pid"] == value["holder"]
        and lock["locktype"] == "transactionid"
        and lock["granted"] is True
    }
    if not any(
        lock["pid"] == value["contender"]
        and lock["locktype"] == "transactionid"
        and lock["granted"] is False
        and lock["transactionid"] in owners
        for lock in value["locks"]
    ):
        raise BarrierFailure("Custody147 exact holder transaction missing")
    return value


def validate_custody147_mode(contract: str, mode: str) -> None:
    """147 expiry waits retain the exact engagement witness; no legacy widening."""
    custody147_probe_query(contract, 1, 2)
    if not contract.startswith("custody147:") or mode not in (
        {"blocked", "expires"}
        if contract.startswith("custody147:engagement:")
        else {"blocked"}
    ):
        raise BarrierFailure("Custody147 proof requires actual blocked mode")


def kill_client(client: subprocess.Popen[bytes]) -> None:
    if client.poll() is None:
        # start_new_session=True below makes this exactly our client's group.
        try:
            os.killpg(client.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    client.wait(timeout=PROBE_TIMEOUT)


def main() -> int:
    (
        container,
        user,
        first_sql,
        second_sql,
        first_path,
        second_path,
        status_path,
        mode,
        expectation,
        expected_value,
    ) = sys.argv[1:11]
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", container) or user not in {
        "postgres",
        "supabase_admin",
    }:
        raise BarrierFailure("Invalid disposable container or database test user")
    if mode not in {"blocked", "nonblocking", "expires"} or expectation not in {
        "success",
        "error",
    }:
        raise BarrierFailure("Invalid race semantics")
    database = sys.argv[11] if len(sys.argv) == 12 else "axiom_policy_test"
    if len(sys.argv) not in {11, 12} or not re.fullmatch(
        r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", database
    ):
        raise BarrierFailure("Invalid disposable database")
    if expected_value.startswith("review141:"):
        review141_probe_query(expected_value, 1, 2)
        if mode != "blocked":
            raise BarrierFailure("Review141 proof requires blocked mode")
    if expected_value.startswith("custody145:"):
        custody145_probe_query(expected_value, 1, 2)
        if mode not in {"blocked", "expires"}:
            raise BarrierFailure("Custody145 proof requires actual blocked mode")
    if expected_value.startswith("custody147:"):
        validate_custody147_mode(expected_value, mode)
    tag = "axiom-race-" + uuid4().hex
    first_name, second_name = tag + "-first", tag + "-second"
    command = [
        "docker",
        "exec",
        "-i",
        "-e",
        f"PGOPTIONS=-c statement_timeout={SERVER_TIMEOUT_MS} -c idle_in_transaction_session_timeout={SERVER_TIMEOUT_MS}",
        container,
        "psql",
        "-X",
        "-U",
        user,
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-Atq",
    ]
    clients: list[subprocess.Popen[bytes]] = []
    holder_pid: int | None = None
    contender_pid: int | None = None
    committed = False
    writer_fd: int | None = None
    result = 1

    def write_input(fd: int, payload: bytes) -> None:
        if len(payload) > 32_768:
            raise BarrierFailure("Fixture SQL exceeds the bounded input size")
        os.set_blocking(fd, False)
        chunk_size = os.fpathconf(fd, "PC_PIPE_BUF")
        end = time.monotonic() + PROBE_TIMEOUT
        offset = 0
        while offset < len(payload):
            remaining = end - time.monotonic()
            if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
                raise BarrierFailure("SQL input exceeded its bounded write deadline")
            try:
                offset += os.write(fd, payload[offset : offset + chunk_size])
            except BlockingIOError:
                continue

    def probe(query: str) -> str:
        client = subprocess.Popen(
            command + ["-c", query],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
        )
        try:
            try:
                output, error = client.communicate(timeout=PROBE_TIMEOUT)
            except subprocess.TimeoutExpired as exc:
                kill_client(client)
                raise BarrierFailure(
                    "Database monitor exceeded its bounded deadline"
                ) from exc
        finally:
            for stream in (client.stdout, client.stderr):
                if stream is not None:
                    stream.close()
        if client.returncode != 0:
            raise BarrierFailure(
                "Database monitor failed: " + error.decode(errors="replace")
            )
        return output.decode().strip()

    def until(predicate, client: subprocess.Popen[bytes], label: str) -> None:
        end = time.monotonic() + PHASE_TIMEOUT
        while time.monotonic() < end:
            if predicate():
                return
            if client.poll() is not None:
                raise BarrierFailure(
                    label + ": SQL client exited before the required proof"
                )
            time.sleep(0.05)
        raise BarrierFailure(label + ": bounded deadline exceeded")

    def wait_result(client: subprocess.Popen[bytes], label: str) -> int:
        try:
            return client.wait(timeout=PHASE_TIMEOUT)
        except subprocess.TimeoutExpired as exc:
            raise BarrierFailure(label + ": result deadline exceeded") from exc

    def interrupted(signum: int, _frame) -> None:
        raise BarrierFailure(f"Race interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with (
            tempfile.TemporaryDirectory(prefix="axiom-race-") as owned_dir,
            open(first_path, "wb", buffering=0) as first_log,
            open(second_path, "wb", buffering=0) as second_log,
        ):
            fifo = Path(owned_dir) / "holder-input"
            os.mkfifo(fifo, 0o600)
            # RDWR avoids an unbounded FIFO-open wait if Docker startup fails.
            # Python descriptors are CLOEXEC; only the holder's stdin is passed.
            writer_fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK | os.O_CLOEXEC)
            with open(fifo, "rb", buffering=0) as reader:
                holder = subprocess.Popen(
                    command,
                    stdin=reader,
                    stdout=first_log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    close_fds=True,
                )
            clients.append(holder)
            payload = (
                f"set application_name='{first_name}'; begin; {first_sql};\n".encode()
            )
            write_input(writer_fd, payload)

            def holder_ready() -> bool:
                nonlocal holder_pid
                value = probe(
                    f"select pid from pg_stat_activity where application_name='{first_name}' and datname=current_database() and state='idle in transaction'"
                )
                if value.isdecimal():
                    holder_pid = int(value)
                    return True
                return False

            until(
                holder_ready,
                holder,
                "First transaction did not reach its uncommitted hold",
            )
            contender = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=second_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
            clients.append(contender)
            if contender.stdin is None:
                raise BarrierFailure("Contender input pipe unavailable")
            write_input(
                contender.stdin.fileno(),
                f"set application_name='{second_name}'; {second_sql};\n".encode(),
            )
            contender.stdin.close()

            if mode == "nonblocking":
                # SKIP LOCKED/visibility must return while the holder is still
                # uncommitted. Waiting for a lock or committing first is wrong.
                second_status = wait_result(
                    contender, "Nonblocking probe waited on the holder"
                )
                value = Path(second_path).read_text().strip()
                if second_status != 0 or value != expected_value:
                    raise BarrierFailure(
                        f"Nonblocking probe expected {expected_value!r} while held, got status {second_status}: {value!r}"
                    )
                if not holder_ready():
                    raise BarrierFailure(
                        "Nonblocking probe lost its uncommitted holder"
                    )
            else:

                def contender_blocked() -> bool:
                    nonlocal contender_pid
                    value = probe(
                        f"select pid from pg_stat_activity contender where application_name='{second_name}' and datname=current_database() and wait_event_type='Lock' and {holder_pid}=any(pg_blocking_pids(contender.pid))"
                    )
                    if value.isdecimal():
                        contender_pid = int(value)
                        return True
                    return False

                until(
                    contender_blocked,
                    contender,
                    "Second transaction did not contend on the actual first holder",
                )
                phase_query = review141_probe_query(
                    expected_value, holder_pid, contender_pid
                )
                if phase_query is None:
                    phase_query = custody145_probe_query(
                        expected_value, holder_pid, contender_pid
                    )
                if phase_query is None:
                    phase_query = custody147_probe_query(
                        expected_value, holder_pid, contender_pid
                    )
                if phase_query is not None:
                    validator = (
                        validate_custody147_phase
                        if expected_value.startswith("custody147:")
                        else validate_custody145_phase
                        if expected_value.startswith("custody145:")
                        else validate_review141_phase
                    )
                    phase_proof = validator(json.loads(probe(phase_query)))
                    proof_path = Path(first_path + ".lock-proof.json")
                    proof_path.write_text(
                        json.dumps(phase_proof, sort_keys=True) + "\n"
                    )
                    proof_path.chmod(0o600)
                if mode == "expires":
                    # The contender emits its exact PostgreSQL one-second
                    # deadline before entering the tool that waits on the lock.
                    deadline = re.search(
                        r"^RACE_DEADLINE=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d(?::\d\d)?)$",
                        Path(second_path).read_text(),
                        re.MULTILINE,
                    )
                    if deadline is None:
                        raise BarrierFailure(
                            "Contender did not emit its exact identity deadline"
                        )
                    until(
                        lambda: (
                            probe(
                                f"select clock_timestamp()>='{deadline.group(1)}'::timestamptz"
                            )
                            == "t"
                        ),
                        contender,
                        "PostgreSQL identity deadline did not expire while blocked",
                    )
                    if (
                        probe(
                            f"select count(*) from pg_stat_activity contender where pid={contender_pid} and application_name='{second_name}' and datname=current_database() and wait_event_type='Lock' and {holder_pid}=any(pg_blocking_pids(contender.pid))"
                        )
                        != "1"
                    ):
                        raise BarrierFailure(
                            "Expiring identity was no longer blocked by its holder"
                        )

            write_input(writer_fd, b"commit;\n\\q\n")
            os.close(writer_fd)
            writer_fd = None
            first_status = wait_result(holder, "First commit")
            if first_status != 0:
                raise BarrierFailure(
                    f"First transaction failed with status {first_status}"
                )
            committed = True
            second_status = wait_result(contender, "Second result")
            Path(status_path).write_text(str(second_status) + "\n")
            if (expectation == "success") != (second_status == 0):
                raise BarrierFailure(
                    f"Second transaction expected {expectation}, got status {second_status}"
                )
        result = 0
    except (BarrierFailure, OSError) as exc:
        print(str(exc), file=sys.stderr)
        try:
            print(
                probe(
                    f"select pid,application_name,state,wait_event_type,wait_event,pg_blocking_pids(pid) from pg_stat_activity where datname=current_database() and application_name in ('{first_name}','{second_name}')"
                ),
                file=sys.stderr,
            )
        except (BarrierFailure, OSError, subprocess.TimeoutExpired) as diagnostic_error:
            print(str(diagnostic_error), file=sys.stderr)
        for label, path in (("first", first_path), ("second", second_path)):
            if Path(path).exists():
                print(
                    label + ": " + Path(path).read_text(errors="replace"),
                    file=sys.stderr,
                )
    finally:
        if writer_fd is not None:
            try:
                if not committed:
                    os.write(writer_fd, b"rollback;\n\\q\n")
            except OSError:
                pass
            os.close(writer_fd)
        # Match the observed PID, application and database. If startup failed
        # before a PID was observed, only that session's random name is used.
        owned_first = f"application_name='{first_name}'" + (
            f" and pid={holder_pid}" if holder_pid is not None else ""
        )
        owned_second = f"application_name='{second_name}'" + (
            f" and pid={contender_pid}" if contender_pid is not None else ""
        )
        if any(client.poll() is None for client in clients):
            try:
                probe(
                    f"select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and (({owned_first}) or ({owned_second}))"
                )
            except (BarrierFailure, OSError, subprocess.TimeoutExpired):
                pass  # Server session deadlines still bound a Docker outage.
        cleanup_failed = False
        for client in clients:
            try:
                kill_client(client)
            except (OSError, subprocess.TimeoutExpired) as cleanup_error:
                print(
                    f"Owned SQL client cleanup failed: {cleanup_error}", file=sys.stderr
                )
                cleanup_failed = True
            finally:
                if client.stdin is not None and not client.stdin.closed:
                    client.stdin.close()
        if cleanup_failed:
            result = 1
    return result


if __name__ == "__main__":
    sys.exit(main())
