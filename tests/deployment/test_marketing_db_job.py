"""Offline source/job payload proofs only: no live SQL or Cloud Run execution."""

import base64
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "marketing_job", ROOT / "scripts/marketing-db-job.py"
)
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)


def configuration():
    data = {
        "GCP_PROJECT_ID": "test-project",
        "GCP_REGION": "asia-south1",
        "ENVIRONMENT": "preprod",
        "MARKETING_MIGRATION_IMAGE": "asia-south1-docker.pkg.dev/test-project/marketing/migrations@sha256:"
        + "a" * 64,
        "MARKETING_MIGRATION_JOB_NAME": "axiom-proof-preprod-migrations",
        "MARKETING_MIGRATION_SERVICE_ACCOUNT": "axiom-proof-preprod-migrations@test-project.iam.gserviceaccount.com",
        "MARKETING_NETWORK_NAME": "axiom-proof-preprod-marketing-network",
        "MARKETING_SUBNETWORK_NAME": "axiom-proof-preprod-marketing-egress",
        "CLOUD_SQL_INSTANCE_NAME": "axiom-proof-preprod-postgres",
        "CLOUD_SQL_DATABASE_NAME": "axiom_proof_preprod",
        "CLOUD_SQL_PRIVATE_IP": "10.73.1.2",
        "CLOUD_SQL_ADMIN_USER": "axiom_admin",
        "MARKETING_MIGRATION_CPU": "1",
        "MARKETING_MIGRATION_MEMORY": "512Mi",
        "MARKETING_MIGRATION_TIMEOUT_SECONDS": "1800",
    }
    for prefix in job.SECRET_BINDINGS.values():
        data[f"MARKETING_{prefix}_SECRET_ID"] = (
            "axiom-proof-preprod-" + prefix.lower().replace("_", "-")
        )
        data[f"MARKETING_{prefix}_SECRET_VERSION"] = "7"
    return data


def runtime():
    source = configuration()
    source.update(
        SUPABASE_DB_URL="postgres://axiom_admin:private-admin-password@10.73.1.2:5432/axiom_proof_preprod?sslmode=require",
        GOTRUE_DB_PASSWORD="auth-secret-password-for-test-only-32chars",
        REST_DB_PASSWORD="rest-secret-password-for-test-only-32chars",
    )
    return source


@pytest.mark.parametrize("phase", job.PHASES)
def test_prepared_job_is_private_single_task_no_retry_and_secret_refs_only(phase):
    source = configuration()
    if phase == "adopt":
        spec = importlib.util.spec_from_file_location(
            "admission_test_inputs", ROOT / "tests/deployment/test_marketing_admission_gate.py"
        )
        inputs_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(inputs_module)
        additional, binding = inputs_module.inputs()
        source.update(additional)
        source["MARKETING_ADOPTION_BINDING"] = json.dumps(binding)
    payload = job.job_payload(source, phase)
    task = payload["template"]["template"]
    assert payload["template"]["taskCount"] == 1
    assert payload["template"]["parallelism"] == 1
    assert task["maxRetries"] == 0
    assert task["vpcAccess"] == {
        "networkInterfaces": [
            {
                "network": "projects/test-project/global/networks/axiom-proof-preprod-marketing-network",
                "subnetwork": "projects/test-project/regions/asia-south1/subnetworks/axiom-proof-preprod-marketing-egress",
            }
        ],
        "egress": "PRIVATE_RANGES_ONLY",
    }
    container = task["containers"][0]
    assert container["args"][-1] == phase
    refs = [entry for entry in container["env"] if "valueSource" in entry]
    assert {entry["name"] for entry in refs} == (
        set(job.SECRET_BINDINGS) if phase == "roles" else {"SUPABASE_DB_URL"}
    )
    assert all(entry["valueSource"]["secretKeyRef"]["version"] == "7" for entry in refs)
    assert all("value" not in entry for entry in refs)
    assert "private-admin-password" not in json.dumps(payload)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("GCP_REGION", "us-central1"),
        ("ENVIRONMENT", "production"),
        ("CLOUD_SQL_PRIVATE_IP", "8.8.8.8"),
        ("CLOUD_SQL_PRIVATE_IP", "127.0.0.1"),
        ("MARKETING_MIGRATION_IMAGE", "unreviewed:latest"),
        ("MARKETING_ADMIN_DB_URL_SECRET_VERSION", "latest"),
        ("MARKETING_NETWORK_NAME", "old-unowned-vpc"),
        (
            "MARKETING_MIGRATION_SERVICE_ACCOUNT",
            "default@other-project.iam.gserviceaccount.com",
        ),
    ],
)
def test_unsafe_job_identity_or_transport_refused(key, value):
    source = configuration()
    source[key] = value
    with pytest.raises(ValueError):
        job.job_payload(source, "roles")


@pytest.mark.parametrize(
    ("key", "value"),
    [
        (
            "SUPABASE_DB_URL",
            "postgres://axiom_admin:secret@8.8.8.8/axiom_proof_preprod",
        ),
        ("SUPABASE_DB_URL", "postgres://axiom_admin:secret@10.73.1.2/wrong_database"),
        (
            "SUPABASE_DB_URL",
            "postgres://authenticator:secret@10.73.1.2/axiom_proof_preprod",
        ),
        (
            "SUPABASE_DB_URL",
            "postgres://axiom_admin:secret@10.73.1.2:5433/axiom_proof_preprod",
        ),
        (
            "SUPABASE_DB_URL",
            "postgres://axiom_admin:secret@10.73.1.2/axiom_proof_preprod?sslmode=disable",
        ),
    ],
)
def test_runtime_refuses_wrong_host_database_role_port_or_cleartext_before_sql(
    monkeypatch, key, value
):
    source = runtime()
    source[key] = value
    calls = []
    monkeypatch.setattr(job, "run_sql", lambda *args: calls.append(args))
    with pytest.raises(ValueError):
        job.run_phase(source, "roles")
    assert calls == []


def test_libpq_environment_cannot_inherit_alternate_target_or_other_secrets(
    monkeypatch,
):
    monkeypatch.setenv("PGHOSTADDR", "8.8.8.8")
    monkeypatch.setenv("PGSERVICE", "other-database")
    monkeypatch.setenv("GOTRUE_DB_PASSWORD", "must-not-reach-psql")
    env = job.runtime_environment(runtime())
    assert env["PGHOST"] == "10.73.1.2"
    assert env["PGUSER"] == "axiom_admin"
    assert "PGHOSTADDR" not in env
    assert "PGSERVICE" not in env
    assert "GOTRUE_DB_PASSWORD" not in env
    assert "SUPABASE_DB_URL" not in env


def test_scram_is_real_verifier_without_plaintext_password():
    password = runtime()["GOTRUE_DB_PASSWORD"]
    verifier = job.scram_verifier(password)
    assert password not in verifier
    _, settings, keys = verifier.split("$")
    iterations, salt = settings.split(":")
    stored, server = keys.split(":")
    salted = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), base64.b64decode(salt), int(iterations)
    )
    assert (
        base64.b64decode(stored)
        == hashlib.sha256(
            hmac.new(salted, b"Client Key", hashlib.sha256).digest()
        ).digest()
    )
    assert (
        base64.b64decode(server)
        == hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    )


def test_roles_phase_empty_auth_before_any_application_series_and_no_raw_password():
    source = runtime()
    sql = job.roles_program(source)
    assert sql.index("roles phase requires empty auth") < sql.index(
        "create schema if not exists auth"
    )
    executable_sql = "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )
    assert "create table if not exists auth.users" not in executable_sql
    assert "Applying:" not in sql
    assert "alter schema auth owner to supabase_auth_admin" in sql
    assert "search_path=auth" in sql
    assert "authenticator login noinherit" in sql
    assert source["GOTRUE_DB_PASSWORD"] not in sql
    assert source["REST_DB_PASSWORD"] not in sql
    assert sql.count("begin;") >= 1
    assert sql.rstrip().endswith("commit;")


def test_series_requires_gotrue_first_preserves_checksums_and_narrow_grants():
    sql = job.series_program()
    assert sql.index("GoTrue own migrations must complete") < sql.index(
        "Applying: 0000_"
    )
    assert "type_name" not in sql  # GoTrue schema enum lookup uses actual pg_type.
    assert "t.typname='factor_type'" in sql
    assert "axiom_migrations.applied" in sql
    grants = sql[sql.index("-- Narrow marketing-only grants") :]
    assert (
        "grant select,insert,update on public.contact_inquiries,public.gap_scan_responses"
        in grants
    )
    assert "grant all on all" not in grants
    assert "for all" not in grants
    assert "rolbypassrls" in grants
    assert "cross join (values('SELECT'),('INSERT'),('UPDATE'))" in grants
    assert "'SELECT,INSERT,UPDATE'" not in grants
    for path in (ROOT / "infra/supabase/migrations").glob("*.sql"):
        assert hashlib.sha256(path.read_bytes()).hexdigest() in sql


def test_psql_argv_and_failure_output_contain_no_secrets(monkeypatch, capsys):
    captured = []

    def fail(argv, **kwargs):
        captured.append((argv, kwargs))
        return SimpleNamespace(
            returncode=1, stderr="secret leaked SQL", stdout="secret leaked SQL"
        )

    monkeypatch.setattr(job.subprocess, "run", fail)
    with pytest.raises(ValueError, match="SQL refused"):
        job.run_sql("protected SQL", job.runtime_environment(runtime()))
    assert captured[0][0] == ["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1"]
    assert "private-admin-password" not in str(captured[0][0])
    assert "secret leaked SQL" not in capsys.readouterr().out


def test_env_source_is_literal_protected_data(tmp_path):
    path = tmp_path / ".env"
    path.write_text("ENVIRONMENT=preprod\nLITERAL='$(touch /tmp/should-not-run)'\n")
    path.chmod(0o600)
    assert job.read_env(path)["LITERAL"] == "$(touch /tmp/should-not-run)"
    path.chmod(0o644)
    with pytest.raises(ValueError, match="owner-only"):
        job.read_env(path)


def test_dockerfile_only_copies_frozen_sql_and_runners_not_secrets():
    text = (ROOT / "infra/docker/Dockerfile.marketing-migrations").read_text()
    assert "ARG POSTGRES_CLIENT_IMAGE\nFROM ${POSTGRES_CLIENT_IMAGE}" in text
    assert "COPY infra/supabase/migrations" in text
    assert "COPY . " not in text
    assert "USER 65532:65532" in text
    assert ".env" not in text


def test_prepare_cli_writes_owner_only_json_without_running_cloud_or_database(
    tmp_path, monkeypatch
):
    env = tmp_path / ".env"
    env.write_text(
        "\n".join(f"{key}={value}" for key, value in configuration().items())
    )
    env.chmod(0o600)
    output = tmp_path / "review" / "job.json"
    monkeypatch.setattr(
        job.sys,
        "argv",
        [
            "marketing-db-job.py",
            "prepare",
            "--env-file",
            str(env),
            "--phase",
            "roles",
            "--output",
            str(output),
        ],
    )

    def no_process(*args, **kwargs):
        raise AssertionError("prepare must not execute any process")

    monkeypatch.setattr(job.subprocess, "run", no_process)
    assert job.main() == 0
    assert output.stat().st_mode & 0o077 == 0
    assert json.loads(output.read_text())["template"]["template"]["maxRetries"] == 0


def test_failed_phase_returns_redacted_cli_failure_and_runs_no_second_phase(
    monkeypatch, capsys
):
    monkeypatch.setattr(
        job.sys, "argv", ["marketing-db-job.py", "run-phase", "--phase", "roles"]
    )
    for key, value in runtime().items():
        monkeypatch.setenv(key, value)
    calls = []

    def fail(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(
            returncode=1,
            stderr="private-admin-password",
            stdout="private-admin-password",
        )

    monkeypatch.setattr(job.subprocess, "run", fail)
    assert job.main() == 1
    assert len(calls) == 1
    output = capsys.readouterr()
    assert "private-admin-password" not in output.out + output.err
    assert "roles phase completed" not in output.out


def test_roles_program_requires_vector_and_limits_connections_and_query_duration():
    sql = job.roles_program(runtime())
    assert "create extension if not exists vector" in sql
    assert "supabase_auth_admin login connection limit 2" in sql
    assert "authenticator login noinherit connection limit 3" in sql
    assert "authenticator set statement_timeout='20s'" in sql
    assert "format('alter role %I connection limit 3',current_user)" in sql
    assert "bypassrls;" not in sql.lower()
    assert "superuser;" not in sql.lower()


@pytest.mark.parametrize(
    "content", ["A=1\nA=2\n", "A=x\0y\n", "PATH=bad\n", "A='unclosed\n"]
)
def test_prepare_reuses_strict_literal_environment_parser(tmp_path, content):
    path = tmp_path / "source.env"
    path.write_text(content)
    path.chmod(0o600)
    with pytest.raises(ValueError):
        job.read_env(path)


def test_prepare_env_keeps_shell_text_inert(tmp_path):
    path = tmp_path / "source.env"
    path.write_text("VALUE='$(touch unwanted)'\n")
    path.chmod(0o600)
    assert job.read_env(path) == {"VALUE": "$(touch unwanted)"}


def test_private_artifact_refuses_symlink_without_truncating_target(tmp_path):
    target = tmp_path / "target"
    target.write_text("retained")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(OSError):
        job.protected_json_write(link, {"private": True})
    assert target.read_text() == "retained"


def test_private_artifact_protects_existing_file_before_writing(tmp_path):
    path = tmp_path / "artifact"
    path.write_text("old")
    path.chmod(0o644)
    job.protected_json_write(path, {"private": True})
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text()) == {"private": True}


def test_managed_adapter_records_exact_original_and_distinct_effective_hashes():
    manifest = job.managed_adapter_manifest()
    assert len(manifest["migrations"]) == 4
    assert sum(len(entry["changes"]) for entry in manifest["migrations"]) == 5
    for entry in manifest["migrations"]:
        original = (
            ROOT / "infra/supabase/migrations" / entry["migration_name"]
        ).read_bytes()
        assert hashlib.sha256(original).hexdigest() == entry["original_sha256"]
        assert entry["effective_body_sha256"] != entry["original_unwrapped_sha256"]
        for change in entry["changes"]:
            assert "rolsuper or rolbypassrls" in change["effective_clause"]
            assert "nobypassrls" not in change["effective_clause"]
    program = job.managed_migration_program()
    assert "before truncate" in program
    assert "deployment adapter receipt is append-only" in program
    assert "recorded managed migration adapter provenance absent or changed" in program


def test_managed_adapter_rejects_changed_frozen_source_hash(monkeypatch):
    original = job.MANAGED_ROLE_ADAPTERS
    changed = {name: {**entry, "sha256": "0" * 64} for name, entry in original.items()}
    monkeypatch.setattr(job, "MANAGED_ROLE_ADAPTERS", changed)
    with pytest.raises(ValueError, match="source hash"):
        job.managed_adapter_manifest()


@pytest.mark.parametrize("change", ["release", "digest", "count", "duplicate"])
def test_library_build_refuses_tampered_source_artifact(tmp_path, change):
    seed = {
        "version": "fixture",
        "controls": [{"id": "one", "library_version": "fixture"}],
    }
    artifact = {
        "schemaVersion": 1,
        "releaseSha": "a" * 40,
        "seed": seed,
        "controlCount": 1,
        "sourceHashes": {"reviewed.ts": "b" * 64},
        "seedSha256": hashlib.sha256(
            json.dumps(seed, separators=(",", ":")).encode()
        ).hexdigest(),
    }
    if change == "release":
        artifact["releaseSha"] = "c" * 40
    elif change == "digest":
        artifact["seedSha256"] = "0" * 64
    elif change == "count":
        artifact["controlCount"] = 2
    else:
        seed["controls"].append(seed["controls"][0])
        artifact["controlCount"] = 2
        artifact["seedSha256"] = hashlib.sha256(
            json.dumps(seed, separators=(",", ":")).encode()
        ).hexdigest()
    path = tmp_path / "artifact.json"
    path.write_text(json.dumps(artifact))
    with pytest.raises(ValueError):
        job.library_seed_program(path, "a" * 40)


def test_library_seed_exact_existing_comparison_and_no_runtime_catalog_grants(tmp_path):
    seed = {
        "version": "fixture",
        "controls": [{"id": "one", "library_version": "fixture"}],
    }
    artifact = {
        "schemaVersion": 1,
        "releaseSha": "a" * 40,
        "seed": seed,
        "controlCount": 1,
        "sourceHashes": {"reviewed.ts": "b" * 64},
        "seedSha256": hashlib.sha256(
            json.dumps(seed, separators=(",", ":")).encode()
        ).hexdigest(),
    }
    path = tmp_path / "artifact.json"
    path.write_text(json.dumps(artifact))
    program = job.library_seed_program(path, "a" * 40)
    assert "Existing library control set mismatch" in program
    assert "Exact published control content mismatch" in program
    assert "Different current library; implicit replacement refused" in program
    assert "grant select" not in program
    assert "before truncate" in program


@pytest.mark.parametrize(
    "tls,database", [(False, "axiom_proof_preprod"), (True, "other")]
)
def test_readonly_inspection_refuses_transport_or_target_mismatch(
    monkeypatch, tls, database
):
    monkeypatch.setattr(
        job.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"database": database, "encrypted_transport": tls}),
        ),
    )
    with pytest.raises(ValueError, match="TLS mismatch"):
        job.inspect_clients(
            {
                "CLOUD_SQL_DATABASE_NAME": "axiom_proof_preprod",
                "AXIOM_RELEASE_SHA": "a" * 40,
            },
            {},
        )


def test_readonly_inspection_uses_tls_environment_no_mutation_or_secret_output(
    monkeypatch, capsys
):
    facts = {
        "database": "axiom_proof_preprod",
        "encrypted_transport": True,
        "clients": [],
    }

    def inspect(argv, **kwargs):
        assert argv == ["psql", "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"]
        assert kwargs["env"]["PGPASSWORD"] == "private-only"
        assert kwargs["env"]["PGSSLMODE"] == "require"
        assert kwargs["timeout"] == 15
        assert kwargs["input"].startswith("begin read only;")
        assert "query," not in kwargs["input"]
        return SimpleNamespace(returncode=0, stdout=json.dumps(facts))

    monkeypatch.setattr(job.subprocess, "run", inspect)
    job.inspect_clients(
        {
            "CLOUD_SQL_DATABASE_NAME": "axiom_proof_preprod",
            "AXIOM_RELEASE_SHA": "a" * 40,
        },
        {"PGPASSWORD": "private-only", "PGSSLMODE": "require"},
    )
    output = capsys.readouterr().out
    assert "private-only" not in output
    assert json.loads(output)["facts"] == facts


def test_readonly_inspection_never_dispatches_migration(monkeypatch):
    source = runtime()
    seen = []
    monkeypatch.setattr(job, "inspect_clients", lambda *args: seen.append(args))
    monkeypatch.setattr(
        job, "run_sql", lambda *args: pytest.fail("inspection mutated database")
    )
    job.run_phase(source, "inspect")
    assert len(seen) == 1


def test_inspection_preserves_unknown_or_background_sessions_for_adoption_review():
    sql = job.inspection_program()
    assert "'backend_type',backend_type" in sql
    assert "backend_type='client backend'" not in sql
    assert "state='idle'" not in sql
    assert "pid<>pg_backend_pid()" in sql
