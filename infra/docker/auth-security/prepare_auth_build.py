"""Create a credential-free, hash-pinned Auth candidate build context."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tarfile
from pathlib import Path, PurePosixPath


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prepare(archive: Path, destination: Path, builder: str) -> str:
    if not re.fullmatch(r"golang@sha256:[0-9a-f]{64}", builder):
        raise ValueError("An explicit immutable official Go builder is required")
    sources = Path(__file__).resolve().parent
    descriptor = json.loads((sources / "source.json").read_bytes())
    if sha(archive.read_bytes()) != descriptor["upstream_archive_sha256"]:
        raise ValueError("Official source archive hash mismatch")
    if destination.exists():
        raise ValueError("Build context must be new; existing contexts are immutable")
    # Validate the entire archive before creating any output. No links/devices.
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 64 * 1024 * 1024:
            raise ValueError("Source archive exceeds bounded context")
        expected_root = "auth-" + descriptor["upstream_commit"]
        for item in members:
            parts = PurePosixPath(item.name).parts
            if (
                not parts
                or parts[0] != expected_root
                or ".." in parts
                or item.name.startswith("/")
            ):
                raise ValueError("Source archive path mismatch")
            if not (item.isfile() or item.isdir()):
                raise ValueError("Source archive contains unsupported links/devices")
        owned = [
            "source.json",
            "apply-patch.go",
            "pgproto3-data-row.patch",
            "pgproto3_regression_test.go",
            "prepare_auth_build.py",
        ]
        contents = {name: (sources / name).read_bytes() for name in owned}
        dockerfile = (sources.parent / "Dockerfile.auth").read_bytes()
        snapshot = {
            "upstream_archive_sha256": sha(archive.read_bytes()),
            "upstream_commit": descriptor["upstream_commit"],
            "go_build_image": builder,
            "owned_files": {name: sha(data) for name, data in contents.items()},
            "Dockerfile.auth": sha(dockerfile),
        }
        encoded = (
            json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        )
        destination.mkdir(mode=0o700, parents=True)
        upstream = destination / "upstream"
        upstream.mkdir(mode=0o700)
        for item in members:
            parts = PurePosixPath(item.name).parts[1:]
            if not parts:
                continue
            target = upstream.joinpath(*parts)
            if item.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                stream = bundle.extractfile(item)
                if stream is None:
                    raise ValueError("Unreadable source member")
                target.write_bytes(stream.read())
                target.chmod(0o755 if item.mode & 0o111 else 0o644)
        review = destination / "review"
        review.mkdir(mode=0o700)
        for name, data in contents.items():
            (review / name).write_bytes(data)
        (review / "source-snapshot.json").write_bytes(encoded)
        (destination / "Dockerfile").write_bytes(dockerfile)
        (destination / ".dockerignore").write_text("**/.git\n**/.env*\n")
        return sha(encoded)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--go-build-image", required=True)
    args = parser.parse_args()
    print(prepare(args.archive, args.context, args.go_build_image))
