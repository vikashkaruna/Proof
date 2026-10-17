#!/usr/bin/env python3
"""LOCAL-ONLY TLS for the owner-test Supabase stack, so the protected custody
credential issuer (infra/local-custody-issuer) runs unchanged: HTTPS backend
origin and ``sslmode=verify-full`` database connections.

- ``ca``       create a local CA and two server certificates (Postgres, gateway)
               under ``.axiom-runtime/local-tls`` (0700 dir, 0600 files). Never
               reissued while present.
- ``db``       enable Postgres SSL on the owner-test DB with ALTER SYSTEM +
               reload (no restart). Plain connections keep working; pg_hba is
               unchanged. Take a backup first (OPS procedure).
- ``gateway``  run ``axiom-supabase-tls`` (nginx, TLS 1.2+) on 127.0.0.1:57443,
               terminating TLS and forwarding to the stack's Kong gateway.
- ``status``   show what is configured.

The CA is trusted only by consumers that are explicitly given ca.pem; it is
never added to a system or browser trust store. Not for production.
"""

from __future__ import annotations

import os
import subprocess  # nosec B404 - fixed openssl/docker argv lists, no shell
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.ci_fixture_images import fixture_image  # noqa: E402

PROJECT = "axiom-owner-test"
DB = f"supabase_db_{PROJECT}"
KONG = f"supabase_kong_{PROJECT}"
STACK_NETWORK = f"supabase_network_{PROJECT}"
APP_NETWORK = "axiom-proof_axiom-network"
GATEWAY = "axiom-supabase-tls"
GATEWAY_PORT = 57443
IMAGE = "axiom-supabase-tls:nginx"
BASE = fixture_image(
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
)
# The main checkout holds retained local data; override for another checkout.
TLS = Path(os.environ.get("AXIOM_LOCAL_TLS_DIR", ROOT / ".axiom-runtime" / "local-tls"))
PG_TLS = "/var/lib/postgresql/data/axiom-tls"
CERTS = {
    "db": "DNS:localhost,IP:127.0.0.1,DNS:supabase-db-axiom-owner-test",
    "gateway": f"DNS:localhost,IP:127.0.0.1,DNS:{GATEWAY}",
}
NGINX = f"""user nginx;
worker_processes 1;
error_log /dev/stderr warn;
pid /tmp/nginx.pid;
events {{ worker_connections 256; }}
http {{
  access_log off;
  client_max_body_size 32m;
  server {{
    listen 8443 ssl;
    ssl_certificate /etc/axiom-tls/gateway.pem;
    ssl_certificate_key /etc/axiom-tls/gateway.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {{
      proxy_pass http://{KONG}:8000;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $http_connection;
      proxy_read_timeout 120s;
    }}
  }}
}}
"""


def run(args: list[str], check: bool = True, **kw) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=300, check=check, **kw)  # nosec B603


def exists(kind: str, name: str) -> bool:
    return run(["docker", kind, "inspect", name], check=False).returncode == 0


def ca() -> None:
    TLS.mkdir(parents=True, exist_ok=True, mode=0o700)
    TLS.chmod(0o700)
    if not (TLS / "ca.key").exists():
        run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"], cwd=TLS)
        run(["openssl", "req", "-new", "-x509", "-key", "ca.key", "-sha256", "-days", "3650",
             "-subj", "/CN=Axiom Proof Local Dev CA",
             "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
             "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem"], cwd=TLS)
    for name, san in CERTS.items():
        if (TLS / f"{name}.pem").exists():
            continue
        run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f"{name}.key"], cwd=TLS)
        run(["openssl", "req", "-new", "-key", f"{name}.key", "-subj", f"/CN={name}", "-out", f"{name}.csr"], cwd=TLS)
        (TLS / f"{name}.ext").write_text(
            "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
            f"extendedKeyUsage=serverAuth\nsubjectAltName={san}\n")
        run(["openssl", "x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
             "-CAcreateserial", "-sha256", "-days", "397", "-extfile", f"{name}.ext", "-out", f"{name}.pem"], cwd=TLS)
        for leftover in (f"{name}.csr", f"{name}.ext"):
            (TLS / leftover).unlink()
    for path in TLS.iterdir():
        path.chmod(0o600)
    print(f"local CA and certificates in {TLS}")


def db() -> None:
    sql = ["docker", "exec", DB, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
           "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres"]
    run(["docker", "exec", DB, "sh", "-c",
         f"mkdir -p {PG_TLS} && chown postgres:postgres {PG_TLS} && chmod 700 {PG_TLS}"])
    run(["docker", "cp", "-q", str(TLS / "db.pem"), f"{DB}:{PG_TLS}/server.crt"])
    run(["docker", "cp", "-q", str(TLS / "db.key"), f"{DB}:{PG_TLS}/server.key"])
    run(["docker", "exec", DB, "sh", "-c",
         f"chown postgres:postgres {PG_TLS}/server.* && chmod 600 {PG_TLS}/server.*"])
    run([*sql, "-c", f"alter system set ssl_cert_file='{PG_TLS}/server.crt'",
         "-c", f"alter system set ssl_key_file='{PG_TLS}/server.key'",
         "-c", "alter system set ssl='on'", "-c", "select pg_reload_conf()"])
    time.sleep(1)
    print("postgres ssl:", run([*sql, "-c", "show ssl"]).stdout.strip())


def gateway() -> None:
    if not exists("image", IMAGE):
        with tempfile.TemporaryDirectory(prefix="axiom-tls-") as temp:
            (Path(temp) / "Dockerfile").write_text(
                f"FROM {BASE}\nRUN apk add --no-cache nginx && mkdir -p /etc/axiom-tls\n"
                'LABEL axiom.local.only="true"\n'
                'ENTRYPOINT ["nginx", "-g", "daemon off;", "-c", "/etc/axiom-tls/nginx.conf"]\n')
            run(["docker", "build", "-t", IMAGE, temp])
    (TLS / "nginx.conf").write_text(NGINX)
    (TLS / "nginx.conf").chmod(0o600)
    if exists("container", GATEWAY):
        run(["docker", "rm", "-f", GATEWAY])
    # The root master reads these root-owned 0600 files; workers run as nginx.
    run(["docker", "create", "--name", GATEWAY, "--restart", "unless-stopped",
         "--network", STACK_NETWORK, "--label", "axiom.purpose=local-tls",
         "-p", f"127.0.0.1:{GATEWAY_PORT}:8443", IMAGE])
    for name in ("nginx.conf", "gateway.pem", "gateway.key"):
        run(["docker", "cp", "-q", str(TLS / name), f"{GATEWAY}:/etc/axiom-tls/{name}"])
    run(["docker", "network", "connect", APP_NETWORK, GATEWAY])
    run(["docker", "start", GATEWAY])
    print(f"{GATEWAY}: https://localhost:{GATEWAY_PORT} -> {KONG}:8000")


def status() -> None:
    print("CA:", (TLS / "ca.pem").exists())
    show = run(["docker", "exec", DB, "psql", "-X", "-qAt", "-h", "127.0.0.1", "-U",
                "supabase_admin", "-d", "postgres", "-c", "show ssl"], check=False)
    print("postgres ssl:", show.stdout.strip() or "unknown")
    state = run(["docker", "inspect", GATEWAY, "--format", "{{.State.Status}}"], check=False)
    print(f"{GATEWAY}:", state.stdout.strip() or "absent")


if __name__ == "__main__":
    actions = {"ca": ca, "db": db, "gateway": gateway, "status": status}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit(__doc__)
    actions[sys.argv[1]]()
