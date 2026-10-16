"""Explicit role bootstrap for owned disposable SQL fixtures, never operators.

Only the pinned 143 role block runs as the image's existing maintenance user.
Application migrations and tests still run as postgres. No role is granted to
postgres and an unsafe existing verifier is refused, never repaired silently.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROLE_DO = """do $$begin
 -- Existing least-privilege roles may be preprovisioned by a trusted privileged
 -- bootstrap. A non-superuser migration must not repeat a role GRANT without
 -- ADMIN OPTION, and may never retain its implicit creator ADMIN membership.
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_verifier') then
  create role axiom_local_custody_verifier nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  grant axiom_local_custody_verifier to authenticator with admin false, inherit false, set true;
 end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_verifier' and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member where r.rolname='axiom_local_custody_verifier')
  or not exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member_role on member_role.oid=m.member where r.rolname='axiom_local_custody_verifier' and member_role.rolname='authenticator' and not m.admin_option and not m.inherit_option and m.set_option)
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member_role on member_role.oid=m.member where r.rolname='axiom_local_custody_verifier' and (member_role.rolname<>'authenticator' or m.admin_option or m.inherit_option or not m.set_option))
 then raise exception 'privileged custody verifier preprovisioning required' using errcode='42501';end if;
end $$;
"""
ROLE_DO_SHA256 = "61d8482b107a873b06b5664ab44abccd3d284438267a9ef83f0221cced7838cc"
NAME = re.compile(
    r"(?:axiom-db-test-[0-9]+|axiom-dsn-test-[0-9]+|axiom-sh-db-[0-9]+|axiom-prativedan-(?:controller-)?[a-f0-9]{12})"
)
CID = re.compile(r"[a-f0-9]{64}")
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},'
    '"running":{{json .State.Running}},"image":{{json .Image}},'
    '"fixture":{{json (index .Config.Labels "com.axiom.fixture")}},'
    '"project":{{json (index .Config.Labels "com.axiom.fixture.project")}},'
    '"owner":{{json (index .Config.Labels "com.axiom.owner-worktree")}}}'
)
READY = "axiom-local-custody-fixture-ready"


class Refused(RuntimeError):
    """Deliberately sanitized: Docker and SQL diagnostics may contain secrets."""


def command(docker: str, args: list[str], *, sql: str | None = None) -> str:
    try:
        result = subprocess.run(  # nosec B603 -- fixed Docker executable, validated argv; no shell
            [docker, *args],
            input=sql,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refused("fixture preprovision command failed") from exc
    if result.returncode:
        raise Refused("fixture preprovision command refused")
    return result.stdout.strip()


def inspect(docker: str, target: str, owner: Path, image: str) -> dict[str, object]:
    try:
        value = json.loads(
            command(docker, ["container", "inspect", "--format", FORMAT, target])
        )
    except (ValueError, TypeError) as exc:
        raise Refused("fixture identity unavailable") from exc
    if (
        not isinstance(value, dict)
        or set(value)
        != {"id", "name", "running", "image", "fixture", "project", "owner"}
        or not isinstance(value["id"], str)
        or not CID.fullmatch(value["id"])
        or not isinstance(value["name"], str)
        or not value["name"].startswith("/")
        or not NAME.fullmatch(value["name"][1:])
        or value["running"] is not True
        or value["image"] != image
        or value["fixture"] != "database-policy-test"
        or value["project"] != "axiom-db-tests"
        or value["owner"] != str(owner)
        or (CID.fullmatch(target) and target != value["id"])
        or (NAME.fullmatch(target) and "/" + target != value["name"])
    ):
        raise Refused("owned disposable fixture identity refused")
    return value


def preprovision(container: str, image_ref: str) -> None:
    owner = Path(__file__).resolve().parents[3]
    if Path.cwd().resolve() != owner:
        raise Refused("fixture worktree context refused")
    if not (NAME.fullmatch(container) or CID.fullmatch(container)):
        raise Refused("disposable fixture name or full ID required")
    if (
        not image_ref
        or len(image_ref) > 512
        or image_ref.startswith("-")
        or any(c.isspace() or ord(c) < 32 for c in image_ref)
    ):
        raise Refused("explicit fixture image required")
    if hashlib.sha256(ROLE_DO.encode("utf-8")).hexdigest() != ROLE_DO_SHA256:
        raise Refused("reviewed fixture role bootstrap changed")
    docker = shutil.which("docker")
    if docker is None:
        raise Refused("Docker executable unavailable")
    image = command(docker, ["image", "inspect", "--format", "{{json .Id}}", image_ref])
    try:
        image = json.loads(image)
    except ValueError as exc:
        raise Refused("fixture image identity unavailable") from exc
    if not isinstance(image, str) or not IMAGE_ID.fullmatch(image):
        raise Refused("full local fixture image ID required")
    original = inspect(docker, container, owner, image)
    # Resolve the caller's name once, then use and revalidate the immutable ID.
    current = inspect(docker, str(original["id"]), owner, image)
    if original != current:
        raise Refused("fixture identity changed before bootstrap")
    sql = (
        """begin;
do $$begin
 if current_user <> 'supabase_admin' or session_user <> 'supabase_admin'
  or not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper)
 then raise exception 'trusted fixture bootstrap required' using errcode='42501';end if;
end $$;
"""
        + ROLE_DO
        + "commit;\nselect '"
        + READY
        + "';\n"
    )
    result = command(
        docker,
        [
            "exec",
            "-i",
            str(current["id"]),
            "psql",
            "-X",
            "-U",
            "supabase_admin",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-Atq",
        ],
        sql=sql,
    )
    if result != READY:
        raise Refused("fixture bootstrap verification unavailable")
    print("Owned disposable custody verifier preprovision verified")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    try:
        preprovision(args.container, args.image)
    except Refused as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
