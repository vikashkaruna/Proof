"""Linux kernel backstop for the fixed isolated worker and its identity CLI."""

from __future__ import annotations

import ctypes
import os
import signal
import sys


def bind_parent_lifetime(expected_parent: int) -> None:
    if sys.platform != "linux":
        raise RuntimeError("Process lifetime binding unavailable")
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise RuntimeError("Process lifetime binding unavailable")
    # The parent may have died between fork and prctl. Never attach to an
    # unrelated new parent and then run without the intended lifetime bound.
    if os.getppid() != expected_parent:
        raise RuntimeError("Process parent changed")
