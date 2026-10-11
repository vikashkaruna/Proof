#!/usr/bin/env python3
"""Validate selected deployment configuration and emit an inert NUL protocol.

No values appear in diagnostics. Template declarations define which inherited
configuration names must be cleared; unrelated tool transport remains intact.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DECLARATION = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
# File configuration must not replace the shell or its command/credential transport.
RESERVED = {
    "REPO_ROOT",
    "ENV_ROOT",
    "ENV_NAME",
    "ENV_FILE",
    "TARGET_ENV",
    "ACTION",
    "COMMAND",
    "DRY_RUN",
    "ASSUME_YES",
    "SKIP_CONFIG",
    "POSITIONAL",
    "MINT_FORCE",
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "OLDPWD",
    "IFS",
    "ENV",
    "BASH_ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "CDPATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "TMPDIR",
    "NODE_OPTIONS",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "AXIOM_ENV_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CONFIG",
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
}


def reserved(key: str) -> bool:
    return key in RESERVED or key.startswith(("BASH_", "OPS_ENV_"))


def parse(path: Path) -> dict[str, str]:
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ValueError("Selected environment file cannot be read as UTF-8") from error
    if "\0" in content:
        raise ValueError("Selected environment file contains an invalid NUL byte")
    pairs: dict[str, str] = {}
    for number, raw in enumerate(content.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^export[ \t]+", "", line)
        if "=" not in line:
            raise ValueError(f"Malformed environment declaration on line {number}")
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not KEY.fullmatch(key) or reserved(key):
            raise ValueError(f"Invalid or reserved environment key on line {number}")
        if key in pairs:
            raise ValueError(f"Duplicate environment key {key} on line {number}")
        if value[:1] in ("'", '"'):
            quote = value[0]
            # No shell escapes/interpolation: preserve the enclosed bytes literally.
            if len(value) < 2 or value[-1] != quote:
                raise ValueError(f"Unclosed quoted environment value on line {number}")
            value = value[1:-1]
        elif value.endswith(("'", '"')):
            raise ValueError(f"Malformed quoted environment value on line {number}")
        pairs[key] = value
    return pairs


def declared_keys(root: Path) -> set[str]:
    templates = sorted((root / "infra/docker/environments").glob(".env.*.example"))
    if not templates:
        raise ValueError("Canonical environment templates are missing")
    keys: set[str] = set()
    for template in templates:
        for line in template.read_text(encoding="utf-8").splitlines():
            match = DECLARATION.match(line)
            if match and not reserved(match[1]):
                keys.add(match[1])
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        values = parse(args.file)
        declared = declared_keys(args.root)
    except ValueError as error:
        print(f"error: {error}.", file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("error: Canonical environment schema cannot be read.", file=sys.stderr)
        return 1
    protocol: list[str] = []
    for key in sorted(declared - values.keys()):
        protocol.extend(("clear", key, ""))
    for key, value in values.items():
        protocol.extend(("set", key, value))
    sys.stdout.buffer.write(
        ("\0".join(protocol) + ("\0" if protocol else "")).encode("utf-8")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
