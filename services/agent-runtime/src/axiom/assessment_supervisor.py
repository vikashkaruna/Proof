"""Linux private-pipe supervisor, separate from the unprivileged fixed worker.

This is a local/portable controller primitive, not Cloud Run attestation. Never
launch it with log-collected foreground stdio. CLI activation is explicit; no
arbitrary command, UID, environment, credential or job input is accepted in argv.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import resource
import signal
import stat
import subprocess  # nosec B404 - launches the fixed in-package worker module; no shell, no CLI-supplied command
import sys
import time
from contextlib import suppress
from functools import partial
from pathlib import Path

from .process_lifetime import bind_parent_lifetime

WORKER = (sys.executable, "-m", "axiom.assessment_worker")
WORKER_UID = 20003
MAX_SECONDS = 65


def child_limits(expected_parent: int):
    bind_parent_lifetime(expected_parent)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:  # NO_NEW_PRIVS
        raise RuntimeError("Worker confinement unavailable")


def cleanup(child: subprocess.Popen, seconds: float = 3) -> bool:
    # A live/unreaped direct child reserves its PID, so the process-group signal
    # cannot hit a reused group. Adopted descendants are handled by pidfd below.
    if child.returncode is None:
        with suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        # Reap every exited descendant. SUBREAPER makes double-forked or detached
        # grandchildren children of this supervisor instead of the container init.
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == 0:
                break
        children = Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()
        for value in children:
            fd = None
            try:
                pid = int(value)
                fd = os.pidfd_open(pid)
                status = Path(f"/proc/{pid}/status").read_text()
                # Protect against PID reuse between the proc snapshot and pidfd.
                if f"PPid:\t{os.getpid()}\n" in status:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        time.sleep(0.01)
    return False


def supervise(command=WORKER, seconds: float = MAX_SECONDS) -> tuple[int, dict]:
    """The command override is for trusted process-tree tests, never CLI input."""
    if sys.platform != "linux" or os.geteuid() != 0 or not 0 < seconds <= MAX_SECONDS:
        raise RuntimeError("Supervisor confinement unavailable")
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # CHILD_SUBREAPER
        raise RuntimeError("Supervisor confinement unavailable")
    child = None
    timed_out, cleaned, code = False, False, None

    def interrupted(_signal, _frame):
        raise InterruptedError("Supervisor interrupted")

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        child = subprocess.Popen(  # nosec B603 - command is the fixed WORKER module tuple or a trusted process-tree test override, never CLI input; no shell
            command,
            stdin=sys.stdin.buffer,
            stdout=sys.stdout.buffer,
            stderr=subprocess.DEVNULL,
            cwd="/worker",
            close_fds=True,
            start_new_session=True,
            user=WORKER_UID,
            group=WORKER_UID,
            extra_groups=[],
            umask=0o077,
            env={
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1",
            },
            preexec_fn=partial(child_limits, os.getpid()),
        )
        try:
            code = child.wait(timeout=seconds)
        except (subprocess.TimeoutExpired, InterruptedError):
            timed_out = True
    finally:
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        if child is not None:
            try:
                cleaned = cleanup(child)
            except Exception:
                cleaned = False
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    result = {"worker_exit": code, "timed_out": timed_out, "cleanup_confirmed": cleaned}
    return (70 if not cleaned else 124 if timed_out else 0 if code == 0 else 1), result


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--private-stdio", action="store_true")
    parser.add_argument("--deadline-seconds", type=float, default=MAX_SECONDS)
    try:
        args = parser.parse_args()
        if not args.private_stdio or not all(stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (0, 1)):
            return 78
        code, report = supervise(seconds=args.deadline_seconds)
        # Appended only after the whole descendant tree has been reaped. The
        # controller requires exactly one final supervisor frame and EOF, and
        # rejects any duplicate forged by a worker. No private fields are copied.
        sys.stdout.write("\n" + json.dumps({"supervisor": report}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        return code
    except Exception:
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
