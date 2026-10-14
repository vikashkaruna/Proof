"""CI-only real PostgreSQL RPC bridge for actual BaseAgent assessment-v2 invocation.

SET ROLE enforces SQL capabilities inside an owned disposable container. This
proves neither PostgREST/JWT authentication nor workload admission or deployment.
No receipt, completion or renderer result is synthesized by this harness.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from prativedan_assessment_interop import protected, read_fixture, write_text

from axiom.agents.prativedan import PrativedanAgent
from axiom.canonicalise import canonical_json, sha256_hex
from axiom.config import Settings
from axiom.evidence_client import EvidenceVault
from axiom.model_gateway import ModelGateway
from axiom.prativedan_assessment_controller_capability import PrativedanControllerLedger
from axiom.prativedan_assessment_dispatch import invoke_assessment_draft
from axiom.prativedan_assessment_draft_codec import (
    AssessmentDraftBinding,
    parse_readback_v2,
    parse_source_v2,
    project_source_v2,
)
from axiom.prativedan_assessment_store import PrativedanAssessmentStore

# No arbitrary function or SQL identifier is ever accepted from an artifact.
RPC_TYPES: dict[str, dict[str, str]] = {
    "load_prativedan_assessment_dispatch": {"t": "uuid", "k": "uuid", "r": "uuid", "rh": "text"},
    "claim_prativedan_assessment_draft": {
        "t": "uuid",
        "k": "uuid",
        "r": "uuid",
        "rh": "text",
        "input_text": "text",
    },
    "read_prativedan_assessment_runtime_receipts": {
        "t": "uuid",
        "k": "uuid",
        "r": "uuid",
        "rh": "text",
        "started": "bigint",
        "completed": "bigint",
    },
    "record_prativedan_assessment_phase": {
        "t": "uuid",
        "k": "uuid",
        "r": "uuid",
        "rh": "text",
        "phase_name": "text",
        "output_hash": "text",
    },
}


def rpc_sql(name: str, arguments: dict[str, Any]) -> str:
    types = RPC_TYPES.get(name)
    if types is None or arguments.keys() != types.keys():
        raise ValueError("Unscoped RPC refused")
    raw = json.dumps(arguments, ensure_ascii=False, allow_nan=False)
    if "\0" in raw or len(raw.encode("utf-8")) > 4_194_304:
        raise ValueError("RPC argument bytes refused")
    literal = "'" + raw.replace("'", "''") + "'::jsonb"
    args = ",".join(
        f"{key}=>((a.v->{'>' if typ != 'jsonb' else ''}'{key}')::{typ})"
        for key, typ in types.items()
    )
    return (
        "set standard_conforming_strings=on; set timezone='UTC'; do $$begin perform set_config('request.jwt.claims',p123_fixture.controller_claims(),false);end$$;set role axiom_prativedan_controller;\n"
        # SQL identifiers are whitelisted; caller values occupy one escaped JSON literal.
        f"select to_jsonb(public.{name}({args},authority=>p123_fixture.authority())) from (select {literal} v) a;\n"  # nosec B608
    )


def owned_container(container_id: str, worktree: Path) -> None:
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or not re.fullmatch("[a-f0-9]{64}", container_id)
        or worktree != Path.cwd().resolve()
    ):
        raise ValueError("Disposable hosted fixture required")
    environment = dict(os.environ)
    environment.pop("DOCKER_CONTEXT", None)
    environment["DOCKER_HOST"] = "unix:///var/run/docker.sock"
    response = subprocess.run(
        ["docker", "inspect", container_id],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
        env=environment,
    )
    info = json.loads(response.stdout)
    if not isinstance(info, list) or len(info) != 1:
        raise ValueError("Container inspection refused")
    item = info[0]
    labels = item.get("Config", {}).get("Labels", {})
    if (
        item.get("Id") != container_id
        or not re.fullmatch(r"/axiom-prativedan-controller-[a-f0-9]{12}", item.get("Name", ""))
        or labels.get("com.axiom.fixture") != "database-policy-test"
        or labels.get("com.axiom.fixture.project") != "axiom-db-tests"
        or labels.get("com.axiom.owner-worktree") != str(worktree)
        or not item.get("State", {}).get("Running")
        or item.get("HostConfig", {}).get("PortBindings")
        or item.get("HostConfig", {}).get("PublishAllPorts")
        or any(item.get("NetworkSettings", {}).get("Ports", {}).values())
    ):
        raise ValueError("Foreign or exposed container refused")


class PgRpcBridge:
    """Each invocation is a short independent actual SQL transaction, scoped role."""

    def __init__(self, container_id: str, worktree: Path):
        owned_container(container_id, worktree)
        self.container_id = container_id
        self.responses: dict[str, list[object]] = {}

    def rpc(self, name: str, arguments: dict[str, Any]) -> PgCall:
        return PgCall(self, name, arguments)

    def execute(self, name: str, arguments: dict[str, Any]) -> object:
        sql = rpc_sql(name, arguments)
        environment = dict(os.environ)
        environment.pop("DOCKER_CONTEXT", None)
        environment["DOCKER_HOST"] = "unix:///var/run/docker.sock"
        response = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                self.container_id,
                "psql",
                "-X",
                "-U",
                "postgres",
                "-d",
                "axiom_proof_local",
                "-v",
                "ON_ERROR_STOP=1",
                "-Atq",
            ],
            input=sql,
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
            env=environment,
        )
        if len(response.stdout.encode("utf-8")) > 8_388_608:
            raise ValueError("RPC reply bound refused")
        value = json.loads(response.stdout)
        self.responses.setdefault(name, []).append(value)
        return value

    async def call(self, name: str, arguments: dict[str, Any]) -> object:
        return await asyncio.to_thread(self.execute, name, arguments)


class PgCall:
    def __init__(self, bridge: PgRpcBridge, name: str, arguments: dict[str, Any]):
        self.bridge = bridge
        self.name = name
        self.arguments = arguments

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self.bridge.execute(self.name, self.arguments))


class NoExternalCalls:
    def __init__(self) -> None:
        self.accesses = 0

    def __getattr__(self, name: str) -> object:
        self.accesses += 1
        raise RuntimeError("External dependency use refused in deterministic fixture")


async def run_fixture(fixture: dict[str, Any], bridge: PgRpcBridge, output_dir: Path) -> None:
    if (
        set(fixture)
        != {
            "schema_version",
            "fixture_kind",
            "requested_readback",
            "sql_input_projection",
            "expected_binding",
        }
        or fixture.get("schema_version") != 1
        or fixture.get("fixture_kind") != "disposable_postgres_assessment_v2"
    ):
        raise ValueError("Actual requested fixture shape refused")
    binding = AssessmentDraftBinding.model_validate(fixture["expected_binding"])
    requested = parse_readback_v2(fixture["requested_readback"], binding)
    if requested.state != "requested":
        raise ValueError("Fresh unclaimed fixture required")
    external = NoExternalCalls()
    agent = PrativedanAgent(
        settings=Settings.model_validate({"environment": "test"}),
        ledger=PrativedanControllerLedger(
            bridge,
            binding,
            sha256_hex(
                canonical_json(
                    project_source_v2(
                        parse_source_v2(requested.source_text, requested.source_sha256)
                    ).model_dump(mode="json")
                )
            ),
        ),
        evidence=cast(EvidenceVault, external),
        model_gateway=cast(ModelGateway, external),
    )
    envelope = await invoke_assessment_draft(PrativedanAssessmentStore(bridge), binding, agent)
    claims = bridge.responses.get("claim_prativedan_assessment_draft", [])
    if len(claims) != 1 or external.accesses:
        raise ValueError("Actual one-shot deterministic invocation refused")
    write_text(output_dir / "pg-claim-first.json", json.dumps(claims[0], ensure_ascii=False))
    write_text(output_dir / "runtime-envelope.json", envelope.model_dump_json())
    write_text(
        output_dir / "runtime-metadata.json",
        json.dumps(
            {
                "fixture_kind": "disposable_postgres_actual_baseagent_assessment_v2",
                "actual_baseagent_invocation": True,
                "agent": "prativedan",
                "source_assessment_agent_execution_proven": False,
                "human_mfa_workflow_proven": False,
                "actual_postgres_receipts": True,
                "postgrest_authentication_proven": False,
                "workload_admission_proven": False,
                "private_controller_channel_proven": False,
                "synthetic_exclusive_controller_custody_fixture": True,
                "external_trust_session_continuity_proven": False,
                "deployed_workflow_proven": False,
                "publication_allowed": False,
                "settlement_proven": False,
                "external_dependency_accesses": external.accesses,
            },
            indent=2,
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    protected(args.output_dir, directory=True)
    if any(args.output_dir.iterdir()):
        parser.error("Output must be empty; evidence is never overwritten")
    bridge = PgRpcBridge(args.container_id, Path.cwd().resolve())
    asyncio.run(run_fixture(read_fixture(args.fixture), bridge, args.output_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
