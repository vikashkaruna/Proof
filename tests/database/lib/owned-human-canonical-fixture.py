"""Feed the same fixed BFF schema vectors into actual PostgreSQL hashing."""

import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
vector = json.loads(
    (root / "tests/database/fixtures/owned-human-canonical-vectors.json").read_text()
)
values = (
    ("snapshot", vector["snapshot"], vector["snapshotHash"]),
    (
        "request",
        {
            "tenantId": vector["tenantId"],
            "actorId": vector["actorId"],
            "request": vector["request"],
        },
        vector["requestHash"],
    ),
    ("proof", vector["proof"], vector["proofHash"]),
)
for name, value, digest in values:
    literal = json.dumps(value, ensure_ascii=False).replace("'", "''")
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Fixed canonical hash vector invalid")
    print(
        f"select pg_temp.ok(owned_synthetic.snapshot_sha256('{literal}'::jsonb)='{digest}',"
        f"'BFF schema to SQL {name} canonical hash parity');"
    )
