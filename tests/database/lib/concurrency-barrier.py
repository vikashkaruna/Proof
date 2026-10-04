#!/usr/bin/env python3
"""Hold a disposable SQL transaction until its actual concurrency proof exists.

Only fixture SQL is accepted from the sibling Bash tests. Every Docker client
starts in an owned process group, so a timeout can kill/reap that client's
descendants without touching any other test, container, or desktop process.
"""

from __future__ import annotations

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
    ) = sys.argv[1:]
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
    database = "axiom_policy_test"
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
