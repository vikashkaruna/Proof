"""Owned-disposable145 concurrency coordinator. Source-only until root runs it.

No retained deployment target is accepted. Each scenario uses a new database
cloned from a committed synthetic template; ledger/history is never rewritten.
Roles are cluster-wide, so ONLY the two synthetic fixture roles are restored
between scenarios and removed after all owned databases are removed.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OWNER = HERE.parents[2]
TENANT = "99143000-0000-4000-8000-000000000011"
NEW = "99143000-0000-4000-8000-000000000204"
EXISTING = "99143000-0000-4000-8000-000000000201"
OPERATOR = "axiom_local_custody_145_fixture_operator"
BRIDGE = "axiom_local_custody_145_fixture_bridge"


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    if spec is None or spec.loader is None:
        raise RuntimeError("owned_fixture_dependency_unavailable")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


GUARD = load("preprovision-local-custody-verifier.py")
FIXTURE = load("local-custody-issuance-race-fixture.py")
BARRIER = load("concurrency-barrier.py")


def external(sql):
    return (
        "\n\\set VERBOSITY verbose\n"
        f"set local session authorization {OPERATOR};set local role axiom_local_custody_issuer;{sql}"
    )


def lock_credential(identity=NEW):
    if identity not in {NEW, EXISTING}:
        raise ValueError("fixture_credential_refused")
    return f"select pg_advisory_xact_lock(hashtextextended('axiom.local-custody.issue.{identity}',0));"


def scenarios():
    issue = external("select local145_race.issue('new')")
    replay = external("select local145_race.issue('existing')")
    retire = external("select local145_race.retire()")
    credential = "custody145:credential:" + NEW
    old_credential = "custody145:credential:" + EXISTING
    tenant_lock = f"select pg_advisory_xact_lock(hashtextextended('{TENANT}',47));"
    revoke_member = f"revoke axiom_local_custody_issuer from {OPERATOR};"
    actor_retire = f"update public.tenant_users set role='viewer' where tenant_id='{TENANT}' and user_id='99143000-0000-4000-8000-000000000001'"
    workload_retire = "update public.workload_identities set status='disabled' where id='99143000-0000-4000-8000-000000000031'"
    cases = []

    def add(
        name,
        holder,
        contender,
        *,
        error=None,
        contract="",
        operation="none",
        mode="blocked",
    ):
        cases.append(
            {
                "name": name,
                "holder": holder,
                "contender": contender,
                "error": error,
                "contract": contract,
                "operation": operation,
                "mode": mode,
            }
        )

    add(
        "membership-at-tenant",
        tenant_lock + revoke_member,
        issue,
        error="42501",
        contract="custody145:tenant:" + TENANT,
    )
    add(
        "membership-at-credential",
        lock_credential() + revoke_member,
        issue,
        error="42501",
        contract=credential,
    )
    add(
        "revoke-membership-at-credential",
        lock_credential(EXISTING) + revoke_member,
        retire,
        error="42501",
        contract=old_credential,
    )
    add(
        "replay-membership-at-credential",
        lock_credential(EXISTING) + revoke_member,
        replay,
        error="42501",
        contract=old_credential,
    )
    add(
        "transitive-at-credential",
        lock_credential()
        + f"grant {OPERATOR} to {BRIDGE} with admin false,inherit false,set true;grant {BRIDGE} to authenticator with admin false,inherit false,set true;",
        issue,
        error="42501",
        contract=credential,
    )
    add(
        "login-at-credential",
        lock_credential() + f"alter role {OPERATOR} nologin;",
        issue,
        error="42501",
        contract=credential,
    )
    add("duplicate-issue", issue, issue, contract=credential, operation="issue")
    add("duplicate-revoke", retire, retire, contract=old_credential, operation="revoke")
    add(
        "lost-response-exact-replay",
        issue,
        issue,
        contract=credential,
        operation="issue",
    )
    add(
        "competing-predecessors",
        external("select local145_race.issue('successor_a')"),
        external("select local145_race.issue('successor_b')"),
        error="23505",
        operation="issue",
    )
    add(
        "policy-revoke-before-issue",
        "select local145_race.policy_revoke()",
        issue,
        error="42501",
        contract="custody145:tenant:" + TENANT,
        operation="policy",
    )
    add(
        "issue-before-policy-revoke",
        issue,
        "select local145_race.policy_revoke()",
        operation="issue_policy",
    )
    add(
        "actor-before-issue",
        lock_credential() + actor_retire,
        issue,
        error="42501",
        contract=credential,
    )
    add("issue-before-actor", issue, actor_retire, operation="issue")
    add(
        "workload-before-issue",
        lock_credential() + workload_retire,
        issue,
        error="42501",
        contract=credential,
    )
    add("issue-before-workload", issue, workload_retire, operation="issue")
    deadline = "select 'RACE_DEADLINE='||to_timestamp((body::jsonb->>'expiresAt')::double precision)::text from local145_race.requests where name='new';"
    # Deadline is output before entering the issuer. The maintained barrier
    # waits for the actual PostgreSQL deadline while the same holder blocks it.
    add(
        "original-expiry-after-wait",
        lock_credential(),
        external(deadline + "select local145_race.issue('new')"),
        error="42501",
        contract=credential,
        mode="expires",
    )
    return cases


SNAPSHOT = """select jsonb_build_object(
'credentials',(select jsonb_build_object('rows',count(*),'hash',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text,'UTF8')),'hex')) from controller_security.local_custody_credentials t),
'issuances',(select jsonb_build_object('rows',count(*),'hash',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by t.credential_id),'[]'::jsonb)::text,'UTF8')),'hex')) from controller_security.local_custody_issuances t),
'revocations',(select jsonb_build_object('rows',count(*),'hash',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by t.credential_id),'[]'::jsonb)::text,'UTF8')),'hex')) from controller_security.local_custody_revocations t),
'ledger',(select jsonb_build_object('rows',count(*),'hash',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text,'UTF8')),'hex')) from public.audit_ledger t),
'history',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by t.name),'[]'::jsonb)::text,'UTF8')),'hex') from axiom_migrations.applied t),
'violations',(select count(*) from public.tenants t cross join lateral public.verify_ledger(t.id)),
'orphanIssuances',(select count(*) from controller_security.local_custody_issuances i left join public.audit_ledger l on l.tenant_id=i.tenant_id and l.id=i.receipt_id where l.id is null or l.action_type::text<>'custody.local_credential_issued' or l.input_hash<>i.request_sha256 or l.actor_type::text<>'system' or l.actor_id<>'axiom-local-custody-issuer' or l.correlation_id<>i.credential_id or l.target_ref<>i.credential_id::text or l.output_hash<>(i.request_text::jsonb->>'policySha256')),
'orphanRevocations',(select count(*) from controller_security.local_custody_revocations i left join public.audit_ledger l on l.tenant_id=i.tenant_id and l.id=i.receipt_id where l.id is null or l.action_type::text<>'custody.local_credential_revoked' or l.input_hash<>i.request_sha256 or l.actor_type::text<>'system' or l.actor_id<>'axiom-local-custody-issuer' or l.correlation_id<>i.credential_id or l.target_ref<>i.credential_id::text or l.output_hash<>(i.request_text::jsonb->>'issuanceSha256')))"""


def validate_outcome(before, after, case):
    if after["history"] != before["history"] or any(
        after[k] != 0 for k in ("violations", "orphanIssuances", "orphanRevocations")
    ):
        raise ValueError("history_or_reciprocal_integrity_failed")
    increments = {
        "none": (0, 0, 0, 0),
        "issue": (1, 1, 0, 1),
        "revoke": (0, 0, 1, 1),
        "policy": (0, 0, 0, 1),
        "issue_policy": (1, 1, 0, 2),
    }[case["operation"]]
    for key, increment in zip(
        ("credentials", "issuances", "revocations", "ledger"), increments, strict=True
    ):
        if after[key]["rows"] != before[key]["rows"] + increment:
            raise ValueError("unexpected_authority_row_count")
        # Revocation mutates exactly one credential; accepted issue/policy races
        # may append a ledger row. Every other unchanged set must match bytes.
        if (
            increment == 0
            and not (key == "credentials" and case["operation"] == "revoke")
            and after[key] != before[key]
        ):
            raise ValueError("unexpected_authority_row_mutation")


class Runner:
    def __init__(self, name, image_ref, directory):
        if Path.cwd().resolve() != OWNER or not GUARD.NAME.fullmatch(name):
            raise ValueError("original_owned_fixture_required")
        self.docker = shutil.which("docker")
        if (
            self.docker is None
            or not image_ref
            or image_ref.startswith("-")
            or any(c.isspace() for c in image_ref)
        ):
            raise ValueError("explicit_fixture_image_required")
        self.image = json.loads(
            GUARD.command(
                self.docker, ["image", "inspect", "--format", "{{json .Id}}", image_ref]
            )
        )
        if not isinstance(self.image, str) or not GUARD.IMAGE_ID.fullmatch(self.image):
            raise ValueError("immutable_image_required")
        self.original = GUARD.inspect(self.docker, name, OWNER, self.image)
        self.cid = str(self.original["id"])
        self.directory = directory
        self.nonce = secrets.token_hex(6)
        self.databases = []
        self.fixture_roles = False

    def owned(self):
        if GUARD.inspect(self.docker, self.cid, OWNER, self.image) != self.original:
            raise ValueError("owned_fixture_changed")

    def run(self, args, *, sql=None):
        self.owned()
        result = subprocess.run(
            [self.docker, *args],
            input=sql,
            text=True,
            capture_output=True,
            timeout=BARRIER.PHASE_TIMEOUT,
            check=False,
        )
        if result.returncode:
            (self.directory / "failed-private-command.log").write_text(
                result.stdout + result.stderr
            )
            raise RuntimeError("owned_fixture_command_failed")
        return result.stdout.strip()

    def sql(self, database, text):
        if database not in self.databases and database not in {
            "postgres",
            "axiom_policy_test",
        }:
            raise ValueError("owned_database_required")
        return self.run(
            [
                "exec",
                "-i",
                "-e",
                f"PGOPTIONS=-c statement_timeout={BARRIER.SERVER_TIMEOUT_MS}",
                self.cid,
                "psql",
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "supabase_admin",
                "-d",
                database,
            ],
            sql=text,
        )

    def create(self, suffix, template):
        name = "axiom_proof_local_145_" + self.nonce + "_" + suffix
        if not re.fullmatch(r"axiom_proof_local_145_[a-f0-9]{12}_[a-z0-9]+", name):
            raise ValueError("owned_database_name_refused")
        if (
            self.sql(
                "postgres",
                "select count(*) from pg_database where datname='" + name + "'",
            )
            != "0"
        ):
            raise ValueError("preexisting_database_refused")
        self.databases.append(name)
        self.run(
            ["exec", self.cid, "createdb", "-U", "supabase_admin", "-T", template, name]
        )
        return name

    def reset_roles(self):
        self.sql(
            "postgres",
            f"begin;revoke {BRIDGE} from authenticator;revoke {OPERATOR} from {BRIDGE};alter role {OPERATOR} login;grant axiom_local_custody_issuer to {OPERATOR} with admin false,inherit false,set true;commit;",
        )

    def race(self, database, case, index):
        folder = self.directory / f"{index:02d}-{case['name']}"
        folder.mkdir(mode=0o700)
        if case["mode"] == "expires":
            self.sql(
                database,
                "update local145_race.requests set body=controller_security.canonical_questionnaire_json(jsonb_set(jsonb_set(body::jsonb,'{issuedAt}',to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint)),'{expiresAt}',to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint+5))) where name='new'",
            )
        before = json.loads(self.sql(database, SNAPSHOT))
        old_ledger_max = self.sql(
            database, "select coalesce(max(id),0) from public.audit_ledger"
        )
        if not old_ledger_max.isdecimal():
            raise ValueError("fixture_ledger_boundary_refused")
        old_ledger_query = (
            "select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb)::text,'UTF8')),'hex') from public.audit_ledger t where id<="
            + old_ledger_max
        )
        old_ledger_hash = self.sql(database, old_ledger_query)
        original_expiry = self.sql(
            database,
            f"select expires_at from controller_security.local_custody_credentials where id='{EXISTING}'",
        )
        self.owned()
        argv = [
            "barrier",
            self.cid,
            "supabase_admin",
            case["holder"],
            "begin;" + case["contender"] + ";commit",
            str(folder / "holder.log"),
            str(folder / "contender.log"),
            str(folder / "status"),
            case["mode"],
            "error" if case["error"] else "success",
            case["contract"],
            database,
        ]
        prior = sys.argv
        try:
            sys.argv = argv
            if BARRIER.main() != 0:
                raise RuntimeError("observed145race_failed")
        finally:
            sys.argv = prior
        if case["error"] and not re.search(
            r"ERROR:\s+" + case["error"] + r"\b", (folder / "contender.log").read_text()
        ):
            raise ValueError("expected_exact_sqlstate_missing")
        after = json.loads(self.sql(database, SNAPSHOT))
        validate_outcome(before, after, case)
        if old_ledger_hash != self.sql(database, old_ledger_query):
            raise ValueError("historical_ledger_bytes_changed")
        if original_expiry != self.sql(
            database,
            f"select expires_at from controller_security.local_custody_credentials where id='{EXISTING}'",
        ):
            raise ValueError("original_credential_expiry_changed")
        if case["name"] in {
            "duplicate-issue",
            "duplicate-revoke",
            "lost-response-exact-replay",
        }:

            def output(name):
                return [
                    json.loads(line)
                    for line in (folder / name).read_text().splitlines()
                    if line.startswith("{")
                ]

            first, second = output("holder.log"), output("contender.log")
            if len(first) != 1 or first != second:
                raise ValueError("exact_positive_replay_mismatch")
        if case["name"] == "lost-response-exact-replay":
            # Explicitly ignore the committed holder's response; reconcile the
            # same retained body a third time, with no fresh key or expiry.
            replay = json.loads(
                self.sql(
                    database,
                    "begin;"
                    + external("select local145_race.issue('new')")
                    + ";commit;",
                )
            )
            if replay != second[0] or json.loads(self.sql(database, SNAPSHOT)) != after:
                raise ValueError("committed_response_loss_replay_changed_authority")
        if (
            case["operation"] in {"policy", "issue_policy"}
            and self.sql(
                database,
                f"select state from public.local_custody_policy_heads where tenant_id='{TENANT}'",
            )
            != "revoked"
        ):
            raise ValueError("policy_revoke_did_not_commit")
        if (
            case["name"] == "competing-predecessors"
            and self.sql(
                database,
                "select count(*) filter(where credential_id='99143000-0000-4000-8000-000000000205')||':'||count(*) filter(where credential_id='99143000-0000-4000-8000-000000000206') from controller_security.local_custody_issuances",
            )
            != "1:0"
        ):
            raise ValueError("predecessor_winner_or_loser_changed")
        if case["contract"] and not (folder / "holder.log.lock-proof.json").exists():
            raise ValueError("exact145lock_witness_missing")
        proof = {
            "name": case["name"],
            "observed": True,
            "expectedSqlState": case["error"],
            "historyUnchanged": True,
            "historicalLedgerBytesUnchanged": True,
            "originalExpiryUnchanged": True,
            "reciprocalViolations": 0,
            "before": before,
            "after": after,
        }
        if case["contract"]:
            proof["lockWitness"] = json.loads(
                (folder / "holder.log.lock-proof.json").read_text()
            )
        (folder / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
        # The original harness captures this safe witness even after temporary
        # files/databases are removed. No synthetic request body is printed.
        print(
            json.dumps({"localCustody145RaceProof": proof}, sort_keys=True), flush=True
        )

    def cleanup(self):
        failures = []
        for database in reversed(self.databases.copy()):
            try:
                self.run(
                    [
                        "exec",
                        self.cid,
                        "dropdb",
                        "-U",
                        "supabase_admin",
                        "--if-exists",
                        database,
                    ]
                )
                self.databases.remove(database)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                failures.append(database)
        if self.fixture_roles and not self.databases:
            count = self.sql(
                "postgres",
                f"select count(*) from pg_roles where rolname in ('{OPERATOR}','{BRIDGE}')",
            )
            if count == "2":
                owned_roles = self.sql(
                    "postgres",
                    f"select count(*) from pg_roles where rolname in ('{OPERATOR}','{BRIDGE}') and shobj_description(oid,'pg_authid')='axiom-local145-race:axiom_proof_local_145_{self.nonce}_template'",
                )
                if owned_roles != "2":
                    raise RuntimeError("fixture_role_nonce_ownership_unverified")
                self.sql(
                    "postgres",
                    f"begin;revoke {BRIDGE} from authenticator;revoke {OPERATOR} from {BRIDGE};revoke axiom_local_custody_issuer from {OPERATOR};drop role {BRIDGE};drop role {OPERATOR};commit;",
                )
            elif count != "0":
                raise RuntimeError("unexpected_partial_fixture_roles")
            self.fixture_roles = False
        if failures:
            raise RuntimeError("owned_race_database_cleanup_incomplete")


def main():
    if len(sys.argv) != 3:
        raise ValueError("owned_fixture_name_and_image_required")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="axiom-local145-races-") as raw:
        folder = Path(raw)
        runner = Runner(sys.argv[1], sys.argv[2], folder)
        try:
            # Never reuse or adopt preexisting global fixture roles.
            if (
                runner.sql(
                    "postgres",
                    f"select count(*) from pg_roles where rolname in ('{OPERATOR}','{BRIDGE}')",
                )
                != "0"
            ):
                raise ValueError("preexisting_synthetic_roles_refused")
            template = runner.create("template", "axiom_policy_test")
            runner.fixture_roles = True
            runner.sql(
                template,
                FIXTURE.setup(
                    HERE.parent / "local-custody-credential-issuance.test.sql"
                ),
            )
            for index, case in enumerate(scenarios()):
                runner.reset_roles()
                database = runner.create(str(index), template)
                runner.race(database, case, index)
                runner.run(
                    ["exec", runner.cid, "dropdb", "-U", "supabase_admin", database]
                )
                runner.databases.remove(database)
                print(
                    "Local custody145 observed race passed:", case["name"], flush=True
                )
        except BaseException:
            # Fixtures contain synthetic data only. Keep diagnostic proof after
            # database cleanup; no credential/token or retained data is present.
            for log in sorted(
                [*folder.rglob("*.log"), *folder.rglob("*.lock-proof.json")]
            ):
                print(
                    log.name + ": " + log.read_text(errors="replace"), file=sys.stderr
                )
            raise
        finally:
            runner.cleanup()
        print(
            "Local custody145:17 observed races; owned databases/roles removed; no retained state."
        )


if __name__ == "__main__":
    main()
