#!/usr/bin/env python3
"""Render only; never install, enroll, apply, overwrite or launch SPIRE."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from lib.spire_deployment import deployment_bundle


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def main() -> None:
    if len(sys.argv) != 3:
        raise ValueError("arguments required")
    source, target = map(Path, sys.argv[1:])
    with source.open("rb") as stream:
        data = stream.read(16385)
    if len(data) > 16384:
        raise ValueError("oversized input")
    bundle = deployment_bundle(json.loads(data, object_pairs_hook=unique_object))
    # Fresh output only, so retries cannot overwrite a reviewed deployment.
    os.umask(0o077)
    target.mkdir(mode=0o700)
    for name, content in bundle.items():
        with (target / name).open("x", encoding="utf-8") as stream:
            stream.write(content)
    print("SPIRE review bundle prepared; no services or registrations activated.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("SPIRE review bundle preparation refused.", file=sys.stderr)
        sys.exit(1)
