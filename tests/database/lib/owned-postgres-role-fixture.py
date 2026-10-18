"""Verify the actual 0166 cluster-role guard on an owned disposable fixture only.

No credentials/memberships are created. Unsafe flag profiles exist only briefly
inside this disposable test cluster and must remain refused, never auto-repaired.
"""

from __future__ import annotations

import importlib.util
import json
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FLAGS = (
    ("rolcanlogin", "LOGIN", "NOLOGIN"),
    ("rolinherit", "INHERIT", "NOINHERIT"),
    ("rolsuper", "SUPERUSER", "NOSUPERUSER"),
    ("rolcreatedb", "CREATEDB", "NOCREATEDB"),
    ("rolcreaterole", "CREATEROLE", "NOCREATEROLE"),
    ("rolreplication", "REPLICATION", "NOREPLICATION"),
    ("rolbypassrls", "BYPASSRLS", "NOBYPASSRLS"),
)


def guard_sql(root: Path = ROOT) -> str:
    source = (
        root / "infra/supabase/migrations/0166_owned_postgresql_boolean_target.sql"
    ).read_text()
    match = re.search(r"do \$owned_role\$\n.*?\n\$owned_role\$;", source, re.DOTALL)
    if match is None or source.count("do $owned_role$") != 1:
        raise ValueError("Exact owned role guard missing")
    return match.group()


class Fixture:
    def __init__(self, name: str, image: str):
        path = ROOT / "tests/database/lib/preprovision-local-custody-verifier.py"
        spec = importlib.util.spec_from_file_location("owned166_role_guard", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.guard = module
        self.docker = shutil.which("docker")
        if (
            Path.cwd().resolve() != ROOT
            or not module.NAME.fullmatch(name)
            or not self.docker
        ):
            raise ValueError("Original owned fixture required")
        image_id = subprocess.run(
            [self.docker, "image", "inspect", image, "--format", "{{.Id}}"],
            capture_output=True,
            text=True,
            check=True,
            timeout=20,
        ).stdout.strip()  # nosec B603
        if not module.IMAGE_ID.fullmatch(image_id):
            raise ValueError("Immutable fixture image required")
        self.image = image_id
        self.original = module.inspect(self.docker, name, ROOT, image_id)
        self.cid = str(self.original["id"])
        self.databases: list[str] = []

    def command(self, args: list[str], sql: str | None = None):
        if self.guard.inspect(self.docker, self.cid, ROOT, self.image) != self.original:
            raise ValueError("Owned fixture changed")
        return subprocess.run(
            [self.docker, "exec", "-i", self.cid, *args],
            input=sql,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )  # nosec B603

    def sql(self, database: str, sql: str, *, refused: bool = False) -> str:
        result = self.command(
            [
                "psql",
                "-X",
                "-U",
                "supabase_admin",
                "-d",
                database,
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-v",
                "VERBOSITY=verbose",
            ],
            sql,
        )
        if refused:
            if (
                result.returncode == 0
                or "42501" not in result.stderr
                or "owned target controller role identity refused" not in result.stderr
            ):
                raise ValueError(
                    "Unsafe role was not refused by the actual source guard"
                )
        elif result.returncode:
            raise ValueError("Owned role fixture statement failed")
        return result.stdout.strip()

    def verify(self) -> None:
        body = guard_sql()
        nonce = secrets.token_hex(6)
        try:
            for suffix in ("a", "b"):
                name = "axiom_owned166_role_" + nonce + "_" + suffix
                if self.command(["createdb", "-U", "supabase_admin", name]).returncode:
                    raise ValueError("Fresh role fixture database refused")
                self.databases.append(name)
                self.sql(name, body)
            database = self.databases[1]
            for field, unsafe, safe in FLAGS:
                self.sql(database, f"alter role owned_target_controller {unsafe};")
                try:
                    self.sql(database, body, refused=True)
                    profile = json.loads(
                        self.sql(
                            database,
                            "select row_to_json(r) from pg_catalog.pg_roles r where rolname='owned_target_controller';",
                        )
                    )
                    if profile.get(field) is not True:
                        raise ValueError("Source guard modified the unsafe role")
                finally:
                    self.sql(database, f"alter role owned_target_controller {safe};")
            self.sql(database, body)
        finally:
            for database in reversed(self.databases):
                if self.command(
                    ["dropdb", "-U", "supabase_admin", database]
                ).returncode:
                    raise ValueError("Owned role fixture cleanup incomplete")
        print(
            json.dumps(
                {
                    "owned166RoleGuard": {
                        "databases": 2,
                        "unsafeProfilesRefused": len(FLAGS),
                        "unsafeRolesNotAutoRepaired": True,
                        "fixtureDatabasesRemoved": True,
                    }
                }
            )
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Owned fixture name and image required")
    Fixture(sys.argv[1], sys.argv[2]).verify()
