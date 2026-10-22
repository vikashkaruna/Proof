"""Explicit historical143/current latest SQL phases; pure preparation, no DB transport.

The parent owns one disposable container and executes emitted SQL with psql.
No product downgrade flag, historical rewrite, broad exception or skipped suite.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HISTORICAL = (
    "public-control-report-provenance.test.sql",
    "public-control-asset-report-provenance.test.sql",
    # Legacy questionnaire-only (source1) lifecycle; 0155 moved NEW requests
    # to source5, covered by questionnaire-evidence-lifecycle.test.sql.
    "board-artifact-versions.test.sql",
    "board-report-generation.test.sql",
    "statutory-source-artifacts.test.sql",
)
CURRENT = "coverage-first-public-reports.test.sql"
MIGRATION = "0144_coverage_first_public_report_presentation.sql"


def need(value: bool, code: str) -> None:
    if not value:
        raise ValueError(code)


def protected(directory: Path) -> Path:
    need(
        directory.is_absolute()
        and directory.resolve() == directory
        and not directory.is_symlink(),
        "fixture_directory_boundary",
    )
    stat = directory.stat()
    need(
        directory.is_dir()
        and stat.st_mode & 0o777 == 0o700
        and stat.st_uid == os.getuid(),
        "owned_protected_directory_required",
    )
    return directory


def plan(root: Path = ROOT) -> dict:
    files = sorted(path.name for path in (root / "tests/database").glob("*.test.sql"))
    need(
        all(name in files for name in (*HISTORICAL, CURRENT)),
        "required_report_suite_missing",
    )
    # 0000 bootstrap is canonical; unpublished0132 was reserved and never shipped.
    migrations = sorted((root / "infra/supabase/migrations").glob("*.sql"))
    versions = [int(p.name[:4]) for p in migrations if p.name[:4].isdigit()]
    need(
        bool(versions)
        and len(versions) == len(migrations)
        and versions == [v for v in range(versions[-1] + 1) if v != 132]
        and versions[-1] >= 145,
        "canonical_latest145_migrations_required",
    )
    need(
        all(
            name in files
            for name in (
                "local-custody-credential-issuance.test.sql",
                "local-custody-credential-issuance-demo.test.sql",
            )
        ),
        "issuer145_suites_required",
    )
    need(
        versions[-1] < 146 or "local-custody-credential-identity.test.sql" in files,
        "identity146_suite_required",
    )
    need(
        versions[-1] < 147
        or "local-public-control-assessment-dispatch.test.sql" in files,
        "dispatch147_suite_required",
    )
    need(
        versions[-1] < 148 or "local-custody-operator-context.test.sql" in files,
        "custody148_context_suite_required",
    )
    need(
        versions[-1] < 149 or "local-custody-intent-cancellation.test.sql" in files,
        "custody149_cancellation_suite_required",
    )
    need(
        versions[-1] < 150 or "local-custody-mfa-time-contract.test.sql" in files,
        "custody150_mfa_clock_suite_required",
    )
    need(
        versions[-1] < 151 or "platform-founder-authority.test.sql" in files,
        "founder151_authority_suite_required",
    )
    need(
        versions[-1] < 152 or "founder-mfa-recovery.test.sql" in files,
        "recovery152_suite_required",
    )
    need(
        versions[-1] < 154 or "mfa-recovery-delegation.test.sql" in files,
        "delegation154_suite_required",
    )
    need(
        versions[-1] < 155
        or {
            "questionnaire-evidence-parity.test.sql",
            "questionnaire-evidence-lifecycle.test.sql",
            "questionnaire-evidence-auditor-lifecycle.test.sql",
        }
        <= set(files),
        "questionnaire155_parity_suite_required",
    )
    need(
        versions[-1] < 156 or "founder-recovers-owners.test.sql" in files,
        "owner_recovery156_suite_required",
    )
    need(
        versions[-1] < 157 or "recorded-dry-run-approval.test.sql" in files,
        "recorded_dry_run157_suite_required",
    )
    need(
        versions[-1] < 158 or "member-approval-scopes.test.sql" in files,
        "member_scopes158_suite_required",
    )
    need(
        versions[-1] < 159 or "catalogue-version-registry.test.sql" in files,
        "catalogue_registry159_suite_required",
    )
    need(
        versions[-1] < 162 or "catalogue-current-version.test.sql" in files,
        "catalogue_current162_suite_required",
    )
    need(
        versions[-1] < 161 or "catalogue-founder-approval.test.sql" in files,
        "catalogue_founder161_suite_required",
    )
    need(
        versions[-1] < 160 or "catalogue-dispatch-downstream.test.sql" in files,
        "catalogue_dispatch160_suite_required",
    )
    for minimum, suites, code in (
        (163, {"postgresql-sandbox-discovery.test.sql"}, "sandbox163_suite_required"),
        (
            164,
            {"full-closure-lifecycle.test.sql", "full-closure-source-graph.test.sql"},
            "closure164_suites_required",
        ),
        (
            165,
            {"postgresql-discovery-requests.test.sql"},
            "discovery165_suite_required",
        ),
        (166, {"owned-postgres-target.test.sql"}, "owned_target166_suite_required"),
        (167, {"owned-human-plans.test.sql"}, "owned_human167_suite_required"),
        (
            168,
            {"owned-execution-binding.test.sql"},
            "owned_execution168_suite_required",
        ),
        (
            169,
            {
                "owned-deployment.test.sql",
                "owned-deployment-enrollment.test.sql",
                "owned-deployment-revocation.test.sql",
            },
            "owned_deployment169_suites_required",
        ),
        (173, {"standing-approval-coordinator.test.sql"}, "standing173_suite_required"),
        (174,{"explicit-data-flow-declarations.test.sql"},"data_flow174_suite_required"),
        (175, {"scheduled-coverage-reassessment.test.sql"}, "scheduled_coverage175_suite_required"),
        (176, {"founder-onboarding-authority.test.sql"}, "founder_onboarding176_suite_required"),
        (177, {"branded-board-lifecycle.test.sql", "branded-auditor-lifecycle.test.sql", "branded-report-parity.test.sql"}, "branding177_suites_required"),
        (178, {"catalogue-reaudit.test.sql"}, "catalogue178_suite_required"),
        (179, {"public-coverage-clarifications.test.sql"}, "coverage179_suite_required"),
        (180, {"clarified-report-parity.test.sql", "clarified-report-lifecycle.test.sql"}, "clarified180_suite_required"),
        (181, {"global-founder-visibility.test.sql"}, "founder181_suite_required"),
        (182, {"sandbox-sql-engines.test.sql"}, "sandbox_engines182_suite_required"),
        (170, {"owned-effect-observations.test.sql"}, "owned_effect170_suite_required"),
        (
            171,
            {"scheduled-postgresql-reads.test.sql"},
            "scheduled_read171_suite_required",
        ),
        (
            172,
            {"prativedan-accounted-terminal.test.sql"},
            "prativedan172_suite_required",
        ),
    ):
        need(versions[-1] < minimum or suites <= set(files), code)
    return {
        "currentVersion": versions[-1],
        "historical143": list(HISTORICAL),
        "current": [name for name in files if name not in HISTORICAL],
        "all": files,
    }


def prepare(directory: Path, root: Path = ROOT) -> None:
    directory = protected(directory)
    need(not list(directory.iterdir()), "fresh_fixture_directory_required")
    migrations = directory / "migrations143"
    migrations.mkdir(mode=0o700)
    files = sorted((root / "infra/supabase/migrations").glob("*.sql"))
    historical = [
        path for path in files if path.name[:4].isdigit() and int(path.name[:4]) <= 143
    ]
    policy = root / "infra/supabase/migrations" / MIGRATION
    need(
        len(historical) == 143 and policy in files,
        "historical143_and_policy144_inventory_required",
    )
    for path in historical:
        shutil.copyfile(path, migrations / path.name)
    latest = directory / "migration144"
    latest.mkdir(mode=0o700)
    shutil.copyfile(policy, latest / MIGRATION)
    (directory / "suite-plan.json").write_text(json.dumps(plan(root), indent=2) + "\n")
    (directory / "executed-suites.txt").write_text("")


def historical_prefix(version: int, root: Path = ROOT) -> str:
    name = HISTORICAL[version - 2]
    text = (root / "tests/database" / name).read_text()
    boundary = "do $$declare kind text;doc jsonb;r jsonb;report public.reports;begin"
    need(text.count(boundary) == 1, "reviewed_legacy_fixture_boundary_changed")
    return text.split(boundary)[0]


def current_program(directory: Path, root: Path = ROOT) -> str:
    # Reuse exact immutable canonical142 setup through creation of pending requests.
    text = (root / "tests/database" / HISTORICAL[1]).read_text()
    boundary = "select pg_temp.ok((select value->>'status'='requested' from board_requested),'board source3 requested');"
    need(text.count(boundary) == 1, "reviewed_current_fixture_boundary_changed")
    setup = text.split(boundary)[0]
    fixture = directory / "parity-fixtures.sql"
    need(
        fixture.is_file()
        and not fixture.is_symlink()
        and fixture.stat().st_size < 4 * 1024 * 1024,
        "generated_parity_fixture_required",
    )
    suite = (root / "tests/database" / CURRENT).read_text()
    need(
        suite.count("-- @coverage144_setup") == 1
        and suite.count("-- @coverage144_parity") == 1,
        "reviewed_current_suite_markers_changed",
    )
    return suite.replace("-- @coverage144_setup", setup).replace(
        "-- @coverage144_parity", fixture.read_text()
    )


def migration_program(directory: Path, root: Path = ROOT) -> str:
    spec = importlib.util.spec_from_file_location(
        "coverage144_migration_runner", root / "scripts/migrate-database.py"
    )
    need(spec is not None and spec.loader is not None, "migration_runner_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.migration_program(directory / "migration144")


def rpc_query() -> str:
    return """select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,
      'identity',pg_get_function_identity_arguments(p.oid),'owner',p.proowner,
      'acl',p.proacl) order by p.proname) as value from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in
      ('capture_board_request_source','capture_statutory_request_source',
       'record_board_report_draft','record_source_bound_statutory_draft',
       'begin_board_artifact_build','begin_statutory_artifact_build')"""


def legacy_program(directory: Path, version: int, root: Path = ROOT) -> str:
    need(version in (2, 3), "explicit_legacy_version_required")
    text = historical_prefix(version, root)
    text += """
-- These are genuine committed request rows, never superuser-invented source rows.
create temporary table coverage144_old_expected as
 select 'board'::text kind,to_jsonb(r) request_row,s.source_text,s.source_sha256,pg_temp.document('board') document
 from public.board_report_requests r join public.board_request_sources s on s.tenant_id=r.tenant_id and s.request_id=r.id
 where r.id=((select value from board_requested)->>'requestId')::uuid
 union all
 select 'auditor',to_jsonb(r),s.source_text,s.source_sha256,pg_temp.document('auditor')
 from public.statutory_report_requests r join public.statutory_request_sources s on s.tenant_id=r.tenant_id and s.request_id=r.id
 where r.id=((select value from auditor_requested)->>'requestId')::uuid;
"""
    text += f"select pg_temp.ok((select count(*)=2 and bool_and(source_text::jsonb->'schema_version'='{version}'::jsonb) and bool_and(request_row->>'status'='requested') from coverage144_old_expected),'genuine committed old pending requests');\n"
    text += "create temporary table coverage144_rpc_before as " + rpc_query() + ";\n"
    text += "select pg_temp.ok((select jsonb_array_length(value)=6 from coverage144_rpc_before),'exact six prior RPC identities');\n"
    text += "create temporary table coverage144_history_before as select to_jsonb(h) value from axiom_migrations.applied h;\nCOMMIT;\n"
    program = migration_program(directory, root)
    text += (
        program
        + "\n"
        + (root / "tests/database/lib/coverage-first-legacy-after.sql").read_text()
    )
    text += (
        "select pg_temp.ok(("
        + rpc_query()
        + ")=(select value from coverage144_rpc_before),'six RPC OID ACL exact after upgrade');\n"
    )
    text += "create temporary table coverage144_rpc_after as " + rpc_query() + ";\n"
    # The exact canonical migration runner performs a checksum no-op on repeat.
    text += "\n" + program + "\n"
    text += (
        "select pg_temp.ok(("
        + rpc_query()
        + ")=(select value from coverage144_rpc_before),'six RPC OID ACL exact after checksum repeat');\n"
    )
    text += "select pg_temp.ok((select count(*)=144 from axiom_migrations.applied),'exact144 history after repeat');\n"
    text += (
        "select jsonb_build_object('database',current_database(),'before',(select value from coverage144_rpc_before),'after',(select value from coverage144_rpc_after),'repeat',("
        + rpc_query()
        + "),'unchanged',true) as coverage144_rpc_parity;\n"
    )
    return text


def verify_inventory(directory: Path, root: Path = ROOT) -> None:
    expected = plan(root)
    expected_rows = [f"143|{name}" for name in expected["historical143"]] + [
        f"{expected['currentVersion']}|{name}" for name in expected["current"]
    ]
    actual = (directory / "executed-suites.txt").read_text().splitlines()
    need(
        len(actual) == len(set(actual)) and sorted(actual) == sorted(expected_rows),
        "suite_inventory_not_exact_once",
    )
    (directory / "suite-inventory-verified.json").write_text(
        json.dumps(
            {
                "suiteCount": len(actual),
                "exactOnce": True,
                "noneOmitted": True,
                "historical143": expected["historical143"],
                "currentVersion": expected["currentVersion"],
                "current": expected["current"],
            },
            indent=2,
        )
        + "\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=[
            "prepare",
            "historical-list",
            "current-list",
            "current-version",
            "current-program",
            "legacy-program",
            "verify",
        ],
    )
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--version", type=int, choices=[2, 3])
    args = parser.parse_args()
    directory = protected(args.directory)
    if args.action == "prepare":
        prepare(directory)
    elif args.action == "current-version":
        print(plan()["currentVersion"])
    elif args.action.endswith("-list"):
        phase = "historical143" if args.action == "historical-list" else "current"
        print("\n".join(plan()[phase]))
    elif args.action == "current-program":
        print(current_program(directory))
    elif args.action == "legacy-program":
        need(args.version in (2, 3), "explicit_legacy_version_required")
        print(legacy_program(directory, args.version))
    else:
        verify_inventory(directory)


if __name__ == "__main__":
    main()
