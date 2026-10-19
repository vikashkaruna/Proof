"""UID20006 network-none input-only renderer; no controller or SDK imports."""

from __future__ import annotations

import json
import os
import sys

from .canonicalise import canonical_json
from .prativedan_contracts import PrativedanInput
from .prativedan_pure_renderer import render_prativedan


def main() -> None:
    if os.getuid() != 20006 or os.getgroups():
        raise ValueError("pure_renderer_identity_refused")
    raw = sys.stdin.buffer.readline(4194305)
    if not raw or len(raw) > 4194304 or not raw.endswith(b"\n"):
        raise ValueError("pure_renderer_input_refused")
    value = json.loads(raw)
    if (
        not isinstance(value, dict)
        or set(value) != {"input_text"}
        or not isinstance(value["input_text"], str)
    ):
        raise ValueError("pure_renderer_input_refused")
    if len(value["input_text"].encode("utf-8")) > 1048576:
        raise ValueError("pure_renderer_input_refused")
    output = render_prativedan(PrativedanInput.model_validate_json(value["input_text"]))
    text = canonical_json(output.model_dump(mode="json"))
    if len(text.encode()) > 1048576:
        raise ValueError("pure_renderer_output_refused")
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Prativedan pure renderer refused.\n")
        raise SystemExit(1) from None
