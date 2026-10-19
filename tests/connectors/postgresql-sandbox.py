"""Own and dispose a synthetic TLS PostgreSQL target for native BFF tests.

Never targets existing containers/databases. Passwords exist only in protected
short-lived files and subprocess memory; no retained stack or env selectors.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="supabase/postgres:17.6.1.127")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    nonce = secrets.token_hex(12)
    name = "axiom-pg-sandbox-" + nonce
    temporary = Path(tempfile.mkdtemp(prefix="axiom-pg-sandbox-")).resolve()
    temporary.chmod(0o700)
    created_id: str | None = None

    def run(command: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
        return subprocess.run(command, check=True, capture_output=True, text=True, **kw)

    try:
        # Resolve a reviewed cached image before any mutation; never pull a new tag.
        image = run(
            ["docker", "image", "inspect", args.image, "--format", "{{.Id}}"]
        ).stdout.strip()
        password = secrets.token_hex(24)
        run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                str(temporary / "key.pem"),
                "-out",
                str(temporary / "cert.pem"),
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
            ]
        )
        (temporary / "password").write_text(password)
        for path in temporary.iterdir():
            path.chmod(0o600)
        command = 'chown postgres:postgres /var/lib/postgresql/data /tmp/key.pem /tmp/cert.pem /tmp/password && exec su postgres -s /bin/sh -c \'initdb -D /var/lib/postgresql/data -U postgres --pwfile=/tmp/password --auth=scram-sha-256 && printf "hostssl all all 0.0.0.0/0 scram-sha-256\\n" >> /var/lib/postgresql/data/pg_hba.conf && exec postgres -D /var/lib/postgresql/data -c listen_addresses="*" -c ssl=on -c ssl_cert_file=/tmp/cert.pem -c ssl_key_file=/tmp/key.pem\''
        created_id = run(
            [
                "docker",
                "create",
                "--name",
                name,
                "--network",
                "bridge",
                "--memory",
                "512m",
                "--cpus",
                "1",
                "--pids-limit",
                "128",
                "--tmpfs",
                "/var/lib/postgresql/data:rw,size=268435456",
                "-p",
                "127.0.0.1::5432",
                "--label",
                "com.axiom.fixture=postgresql-sandbox",
                "--label",
                "com.axiom.fixture.project=axiom-postgresql-discovery",
                "--label",
                "com.axiom.owner-nonce=" + nonce,
                "--label",
                "com.axiom.owner-worktree=" + str(root),
                "--entrypoint",
                "/bin/sh",
                image,
                "-c",
                command,
            ]
        ).stdout.strip()
        for path in temporary.iterdir():
            run(["docker", "cp", str(path), created_id + ":/tmp/" + path.name])
        run(["docker", "start", created_id])
        for _ in range(100):
            if (
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        created_id,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-U",
                        "postgres",
                    ],
                    check=False,
                    capture_output=True,
                ).returncode
                == 0
            ):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Owned TLS fixture failed readiness")
        inspection = json.loads(run(["docker", "inspect", created_id]).stdout)[0]
        port = int(inspection["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"])
        expiry = int(time.time() * 1000) + 300000
        credential = {
            "schemaVersion": 1,
            "tenantId": "52520000-0000-4000-8000-000000000001",
            "connectorId": "52520000-0000-4000-8000-000000000003",
            "credentialId": "52520000-0000-4000-8000-000000000005",
            "revision": 1,
            "expiresAt": expiry,
            "password": password,
        }
        credential_path = temporary / "credential.json"
        credential_path.write_text(json.dumps(credential))
        credential_path.chmod(0o600)
        fixture_path = temporary / "fixture.json"
        fixture_path.write_text(
            json.dumps(
                {
                    "containerId": created_id,
                    "ownerNonce": nonce,
                    "image": image,
                    "port": port,
                    "caFile": str(temporary / "cert.pem"),
                    "password": password,
                    "credentialFile": str(credential_path),
                    "expiresAt": expiry,
                }
            )
        )
        fixture_path.chmod(0o600)
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "vitest",
                "run",
                "src/connectors/postgresql-sandbox.native.test.ts",
            ],
            check=False,
            cwd=root / "services/bff",
            env={**os.environ, "AXIOM_OWNED_POSTGRESQL_FIXTURE": str(fixture_path)},
            capture_output=True,
            text=True,
        )
        if result.returncode:
            # Native errors are generic and never contain fixture credentials.
            diagnostic = (result.stdout + result.stderr).replace(password, "[redacted]")
            print(diagnostic)
            raise RuntimeError("Owned PostgreSQL native assertions failed")
        print(result.stdout)
    finally:
        try:
            if created_id:
                inspection = json.loads(run(["docker", "inspect", created_id]).stdout)[
                    0
                ]
                if inspection["Config"]["Labels"].get("com.axiom.owner-nonce") != nonce:
                    raise RuntimeError("Owned fixture cleanup refused")
                run(["docker", "rm", "-f", created_id])
        finally:
            shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
