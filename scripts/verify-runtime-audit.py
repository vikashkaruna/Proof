#!/usr/bin/env python3
"""Exercise the Python runtime against the isolated local parity Postgres stack.

Run through the agent-runtime uv environment after start-parity-supabase.sh.
Only synthetic rows are created. Append-only ledger records remain as evidence.
Never point this harness at a client deployment; only port 56321 loopback is accepted.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess  # nosec B404 - fixed read-only git queries; list argv, no shell
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import urlsplit
from uuid import uuid4

from axiom.agents.base import AgentName, BaseAgent
from axiom.config import Settings
from axiom.ledger_client import LedgerClient
from pydantic import BaseModel
from supabase import create_client

ROOT = Path(__file__).resolve().parents[1]
PHASE = "configuration"


class ProbeInput(BaseModel):
    tenant_id: str
    private_value: str


class ProbeOutput(BaseModel):
    private_value: str


class ProbeAgent(BaseAgent[ProbeInput, ProbeOutput]):
    name = AgentName.PRATIVEDAN

    def input_schema(self):
        return ProbeInput

    def output_schema(self):
        return ProbeOutput

    async def _run(self, *, correlation_id, input, **deps):
        return ProbeOutput(private_value=input.private_value)


async def main() -> None:
    global PHASE
    os.umask(0o077)
    (ROOT / ".axiom-runtime" / "runtime-audit" / "results.json").unlink(missing_ok=True)
    logging.disable(logging.CRITICAL)
    status_dir = Path(os.environ.get("AXIOM_PARITY_STATE_DIR", ROOT / ".axiom-runtime/parity"))
    status = json.loads((status_dir / "status.json").read_text())
    url = urlsplit(status["API_URL"])
    if (
        url.scheme != "http"
        or url.hostname not in {"localhost", "127.0.0.1"}
        or url.port != 56321
        or url.username
        or url.password
    ):
        raise RuntimeError("isolated target required")
    settings = Settings(
        _env_file=None,
        environment="preprod",
        supabase_url=status["API_URL"],
        supabase_service_key=status["SERVICE_ROLE_KEY"],
    )
    ledger = LedgerClient.from_settings(settings)
    if ledger.in_memory_mode:
        raise RuntimeError("durable ledger required")
    db = create_client(status["API_URL"], status["SERVICE_ROLE_KEY"])
    tenant_id = str(uuid4())
    PHASE = "tenant-fixture"
    db.table("tenants").insert(
        {
            "id": tenant_id,
            "slug": "runtime-audit-" + tenant_id,
            "name": "Synthetic runtime audit acceptance",
        }
    ).execute()
    agent = ProbeAgent(settings=settings, ledger=ledger, evidence=Mock(), model_gateway=Mock())
    agent.log = Mock()
    private = "synthetic-audit-probe-" + str(uuid4())
    PHASE = "agent-invocation"
    result = await agent.invoke({"tenant_id": tenant_id, "private_value": private})
    if result.status != "succeeded" or len(result.ledger_entry_ids) != 2:
        raise RuntimeError("invocation refused")
    PHASE = "ledger-read"
    rows = (
        db.table("audit_ledger")
        .select("id,result,input_hash,output_hash,detail")
        .eq("tenant_id", tenant_id)
        .order("sequence_no")
        .execute()
        .data
    )
    if len(rows) != 2 or [row["result"] for row in rows] != ["pending", "success"]:
        raise RuntimeError("missing durable records")
    if {str(row["id"]) for row in rows} != set(result.ledger_entry_ids):
        raise RuntimeError("receipt mismatch")
    if private in json.dumps(rows) or private in str(agent.log.mock_calls):
        raise RuntimeError("unredacted audit")
    if rows[0]["input_hash"] != rows[1]["input_hash"] or not rows[1]["output_hash"]:
        raise RuntimeError("missing digests")
    PHASE = "chain-verification"
    if (await ledger.verify(tenant_id)).get("intact") is not True:
        raise RuntimeError("ledger verification failed")
    output = ROOT / ".axiom-runtime" / "runtime-audit" / "results.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git is required for revision reporting")
    revision = subprocess.run(  # nosec B603 - git resolved above, constant read-only arguments, no shell
        [git, "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    dirty = bool(
        subprocess.run(  # nosec B603 - git resolved above, constant read-only arguments, no shell
            [git, "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    )
    if os.environ.get("CI") == "true" and dirty:
        raise RuntimeError("clean CI checkout required")
    output.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "isolated-runtime-audit",
                "passed": True,
                "revision": revision,
                "dirty": dirty,
                "outcomes": {
                    "strict-durable-ledger": True,
                    "confirmed-receipts": True,
                    "redacted-audit-and-logs": True,
                    "input-output-digests": True,
                    "chain-verification": True,
                },
            },
            indent=2,
        )
        + "\n"
    )
    print("Runtime audit acceptance passed: 5 real Postgres outcomes.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print(
            f"Runtime audit acceptance failed at {PHASE}. Private configuration and payloads were not emitted."
        )
        raise SystemExit(1) from None
