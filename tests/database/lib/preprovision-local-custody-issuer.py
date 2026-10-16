"""Empty issuer role bootstrap for guarded disposable fixtures, never operators.

145 requires an explicitly precreated safe NOLOGIN role with no members. This
helper creates no operator login, token, key or membership. Existing unsafe roles
are refused rather than repaired. The independent143 bootstrap stays untouched.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import sys
import tomllib
from pathlib import Path

_shared_spec = importlib.util.spec_from_file_location(
    "custody143_disposable_guard",
    Path(__file__).with_name("preprovision-local-custody-verifier.py"),
)
if _shared_spec is None or _shared_spec.loader is None:
    raise RuntimeError("Reviewed disposable guard unavailable")
_shared = importlib.util.module_from_spec(_shared_spec)
_shared_spec.loader.exec_module(_shared)
Refused = _shared.Refused
command = _shared.command
ROLE_DO = """do $$begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_issuer') then
  create role axiom_local_custody_issuer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_issuer'
   and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member where r.rolname='axiom_local_custody_issuer')
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid where r.rolname='axiom_local_custody_issuer')
 then raise exception 'explicit empty protected local issuer role required' using errcode='42501';end if;
end $$;
"""
ROLE_DO_SHA256 = "63a12a927234a2e2ca5ca2b5e45e96fb1ae7b56f79176b5ba642b00dab428501"
READY = "axiom-local-custody-issuer-fixture-ready"
PARITY_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},'
    '"image":{{json .Image}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},'
    '"workdir":{{json (index .Config.Labels "com.supabase.cli.workdir")}},'
    '"ports":{{json .NetworkSettings.Ports}}}'
)


def parity_location(owner: Path, state: Path, project: str, prefix: str) -> None:
    if not re.fullmatch(r"[0-9]{3}", prefix):
        raise Refused("parity fixture port prefix refused")
    expected = owner / ".axiom-runtime" / "parity"
    match = re.fullmatch(r"axiom-report-([a-f0-9]{12})", project)
    if match:
        expected = (
            owner / ".axiom-runtime" / ("registered-report-" + match[1]) / "parity"
        )
    elif project != "axiom-w0-parity":
        raise Refused("owned parity fixture project refused")
    if (
        state != expected
        or not state.is_absolute()
        or state.resolve() != state
        or state.is_symlink()
    ):
        raise Refused("owned parity fixture path refused")


def prepare_parity_paths(owner: Path, state: Path, project: str, prefix: str) -> None:
    """Protect only owned, canonical disposable paths before any CLI startup.

    Earlier offline tests may create .axiom-runtime under umask022. Restrict
    that directory rather than weakening the later privileged identity guard.
    No Docker, role installation or retained deployment path is accepted here.
    """
    parity_location(owner, state, project, prefix)
    owner_stat = owner.lstat()
    if (
        owner.resolve() != owner
        or not stat.S_ISDIR(owner_stat.st_mode)
        or owner_stat.st_uid != os.getuid()
        or owner_stat.st_mode & 0o022
    ):
        raise Refused("owned parity workspace refused")
    paths = list(
        dict.fromkeys(
            [owner / ".axiom-runtime", state.parent, state, state / "supabase"]
        )
    )
    config = state / "supabase/config.toml"
    # Refuse all existing unsafe identities before changing any permissions.
    for path in [*paths, config]:
        try:
            value = path.lstat()
        except FileNotFoundError:
            continue
        valid_kind = (
            stat.S_ISREG(value.st_mode)
            if path == config
            else stat.S_ISDIR(value.st_mode)
        )
        if (
            not valid_kind
            or value.st_uid != os.getuid()
            or path.resolve() != path
            or (path == config and (value.st_nlink != 1 or value.st_size > 65536))
        ):
            raise Refused("owned parity preparation identity refused")
    for path in paths:
        path.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if os.fstat(fd).st_uid != os.getuid():
                raise Refused("owned parity preparation identity refused")
            os.fchmod(fd, 0o700)
        finally:
            os.close(fd)
    if config.exists():
        fd = os.open(config, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            value = os.fstat(fd)
            if (
                not stat.S_ISREG(value.st_mode)
                or value.st_uid != os.getuid()
                or value.st_nlink != 1
            ):
                raise Refused("owned parity preparation identity refused")
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)


def parity_inspect(
    docker: str,
    target: str,
    image: str,
    owner: Path,
    state: Path,
    project: str,
    prefix: str,
    *,
    api: bool = False,
) -> dict:
    # Only already-used engineering fixture families are accepted. A retained
    # project cannot become eligible merely by providing a matching image/name.
    parity_location(owner, state, project, prefix)
    for label, path in [
        ("state", state),
        ("state_parent", state.parent),
        ("runtime_root", owner / ".axiom-runtime"),
    ]:
        stat = path.stat()
        if (
            not path.is_dir()
            or path.is_symlink()
            or path.resolve() != path
            or stat.st_uid != os.getuid()
            or stat.st_mode & 0o077
        ):
            raise Refused("protected parity fixture ancestry refused: " + label)
    config = state / "supabase/config.toml"
    stat = config.lstat()
    if (
        not config.is_file()
        or config.is_symlink()
        or config.resolve() != config
        or stat.st_uid != os.getuid()
        or stat.st_mode & 0o077
        or stat.st_size > 65536
    ):
        raise Refused("protected parity fixture config refused")
    try:
        parsed = tomllib.loads(config.read_text())
        if (
            not isinstance(parsed.get("db"), dict)
            or not isinstance(parsed.get("api"), dict)
            or parsed.get("project_id") != project
            or parsed.get("db", {}).get("port") != int(prefix + "22")
            or parsed.get("api", {}).get("port") != int(prefix + "21")
        ):
            raise Refused("parity config binding refused")
        value = json.loads(
            command(docker, ["container", "inspect", "--format", PARITY_FORMAT, target])
        )
    except (ValueError, TypeError, OSError) as error:
        raise Refused("parity fixture identity unavailable") from error
    ports = value.get("ports") if isinstance(value, dict) else None
    bindings = (
        ports.get("8000/tcp" if api else "5432/tcp")
        if isinstance(ports, dict)
        else None
    )
    expected_name = f"supabase_{'kong' if api else 'db'}_{project}"
    if (
        not isinstance(value, dict)
        or set(value)
        != {"id", "name", "running", "image", "project", "workdir", "ports"}
        or not isinstance(value.get("id"), str)
        or not _shared.CID.fullmatch(value["id"])
        or value["name"] != "/" + expected_name
        or value["running"] is not True
        or value["image"] != image
        or value["project"] != project
        or value["workdir"] != str(state)
        or not isinstance(bindings, list)
        or not bindings
        or any(
            not isinstance(binding, dict)
            or binding.get("HostPort") != prefix + ("21" if api else "22")
            or binding.get("HostIp") not in ["127.0.0.1", "0.0.0.0", "::"]
            for binding in bindings
        )
        or (_shared.CID.fullmatch(target) is not None and target != value["id"])
        or (not _shared.CID.fullmatch(target) and target != expected_name)
    ):
        raise Refused("owned parity fixture identity refused")
    return value


def preprovision(
    container: str,
    image_ref: str,
    *,
    state: Path | None = None,
    project: str | None = None,
    prefix: str | None = None,
    api_image_ref: str | None = None,
) -> None:
    owner = Path(__file__).resolve().parents[3]
    if Path.cwd().resolve() != owner:
        raise Refused("fixture worktree context refused")
    if hashlib.sha256(ROLE_DO.encode()).hexdigest() != ROLE_DO_SHA256:
        raise Refused("reviewed issuer bootstrap changed")
    if (
        not image_ref
        or len(image_ref) > 512
        or image_ref.startswith("-")
        or any(c.isspace() or ord(c) < 32 for c in image_ref)
    ):
        raise Refused("explicit fixture image required")
    if state is None:
        if (
            project is not None
            or prefix is not None
            or api_image_ref is not None
            or not (
                _shared.NAME.fullmatch(container) or _shared.CID.fullmatch(container)
            )
        ):
            raise Refused("owned disposable fixture name required")
    elif (
        project is None
        or prefix is None
        or api_image_ref is None
        or not re.fullmatch(r"[0-9]{3}", prefix)
    ):
        raise Refused("complete parity fixture scope required")
    docker = shutil.which("docker")
    if docker is None:
        raise Refused("Docker executable unavailable")
    try:
        image = json.loads(
            command(docker, ["image", "inspect", "--format", "{{json .Id}}", image_ref])
        )
    except ValueError as error:
        raise Refused("fixture image identity unavailable") from error
    if not isinstance(image, str) or not _shared.IMAGE_ID.fullmatch(image):
        raise Refused("full local fixture image ID required")

    def inspect(target):
        return (
            _shared.inspect(docker, target, owner, image)
            if state is None
            else parity_inspect(docker, target, image, owner, state, project, prefix)
        )

    original = inspect(container)
    api_original = None
    if state is not None:
        if not _shared.IMAGE_ID.fullmatch(api_image_ref):
            raise Refused("full parity API image ID required")
        try:
            api_image = json.loads(
                command(
                    docker,
                    ["image", "inspect", "--format", "{{json .Id}}", api_image_ref],
                )
            )
        except ValueError as error:
            raise Refused("parity API image unavailable") from error
        if api_image != api_image_ref:
            raise Refused("parity API image identity changed")
        api_original = parity_inspect(
            docker,
            "supabase_kong_" + project,
            api_image,
            owner,
            state,
            project,
            prefix,
            api=True,
        )
    current = inspect(original["id"])
    if original != current:
        raise Refused("fixture identity changed before issuer bootstrap")
    if api_original is not None and api_original != parity_inspect(
        docker, api_original["id"], api_image, owner, state, project, prefix, api=True
    ):
        raise Refused("parity API identity changed before issuer bootstrap")
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
            current["id"],
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
        raise Refused("issuer bootstrap verification unavailable")
    print("Owned disposable empty local issuer role preprovision verified")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container")
    parser.add_argument("--image")
    parser.add_argument("--prepare-parity-paths", action="store_true")
    parser.add_argument("--parity-state", type=Path)
    parser.add_argument("--project")
    parser.add_argument("--port-prefix")
    parser.add_argument("--api-image")
    args = parser.parse_args()
    try:
        if args.prepare_parity_paths:
            if (
                not args.parity_state
                or not args.project
                or not args.port_prefix
                or args.container
                or args.image
                or args.api_image
            ):
                raise Refused("explicit path preparation arguments required")
            owner = Path(__file__).resolve().parents[3]
            if Path.cwd().resolve() != owner:
                raise Refused("original owned workspace required")
            prepare_parity_paths(
                owner, args.parity_state, args.project, args.port_prefix
            )
            print("Owned parity fixture paths protected")
            return 0
        if not args.container or not args.image:
            raise Refused("owned container and explicit image required")
        preprovision(
            args.container,
            args.image,
            state=args.parity_state,
            project=args.project,
            prefix=args.port_prefix,
            api_image_ref=args.api_image,
        )
    except (Refused, OSError) as error:
        print(
            str(error)
            if isinstance(error, Refused)
            else "fixture filesystem boundary refused",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
