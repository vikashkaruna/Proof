"""W5 · M3.2 — the dry-run / simulation engine.

Per action type, a simulator that produces a *structured diff*
(before/after), not prose. Doc 04 §3.2 is load-bearing here: if the diff
cannot be rendered legibly, the action is not eligible for agent
execution and routes to manual handling — so the engine must be able to
refuse. A refusal is an outcome, not an error: it is recorded, ledgered,
and it invalidates any earlier dry-run that made the action eligible.

This slice simulates from *declared* content only — the action's stored
parameters, blast radius and rollback definition. It invents nothing: a
record count the plan never declared stays `null` with
`records_declared: false`, never a plausible-looking number. When the
executor slice (M3.4) lands with a real write adapter, it must recompute
against the live estate and the reconciler (W5.6) proves the two agree.

The module is pure: no I/O, no clocks, no randomness. The same declared
content always produces the same diff, so the hashes `record_dry_run`
computes over it are stable.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

# The BFF sends this version; a mismatch is a deployment error and is
# refused with a reason, mirroring the execution dispatch contract.
DRY_RUN_CONTRACT_VERSION = 1

MAX_PARAMETERS_BYTES = 65_536
MAX_FIELD_COUNT = 100

# A parameter or diff field name is an identifier-shaped token, never free
# text: names only, no personal values.
_IDENTIFIER = re.compile(r"^[A-Za-z0-9_. -]{1,200}$")


@dataclass(frozen=True)
class DryRunOutcome:
    status: str  # 'succeeded' | 'refused' | 'failed'
    diff: dict[str, Any] | None
    refusal_reason: str | None


def _is_identifier(value: Any) -> bool:
    return isinstance(value, str) and bool(_IDENTIFIER.match(value))


def _is_identifier_list(value: Any) -> bool:
    return (
        isinstance(value, list)
        and 0 < len(value) <= MAX_FIELD_COUNT
        and all(_is_identifier(item) for item in value)
    )


def _is_optional_identifier_list(value: Any) -> bool:
    return value is None or (
        isinstance(value, list)
        and len(value) <= MAX_FIELD_COUNT
        and all(_is_identifier(item) for item in value)
    )


def _is_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10**12


def _declared_records(blast_radius: dict[str, Any]) -> int | None:
    """The record count the plan declared, if any. Never guessed."""
    for key in ("records", "affected_records", "record_count"):
        value = blast_radius.get(key)
        if _is_count(value):
            return value
    return None


def _rollback_fact(rollback_definition: dict[str, Any]) -> dict[str, Any]:
    return {"defined": isinstance(rollback_definition, dict) and len(rollback_definition) > 0}


# ─────────────────────────────────────────────────────────────────────
# The typed action catalogue. Every `action_type` in the Postgres enum
# has either a parameter spec (simulable — the diff builder renders it)
# or no entry (`custom`: structurally arbitrary, never simulable, always
# routed to manual handling).
# ─────────────────────────────────────────────────────────────────────
#
# A spec lists each REQUIRED parameter with its shape checker. Anything
# outside the spec is refused, so an unvalidated key can never reach a
# diff. Optional keys are checked when present.

DATA_ACTION = "data"
POLICY_ACTION = "policy"

_PARAMETER_SPECS: dict[str, dict[str, tuple[Callable[[Any], bool], bool]]] = {
    # Data actions (require rollback plan): system + what changes.
    "data.mask": {
        "system": (_is_identifier, True),
        "fields": (_is_identifier_list, True),
        "criteria": (_is_identifier, False),
    },
    "data.delete": {
        "system": (_is_identifier, True),
        "criteria": (_is_identifier, True),
    },
    "data.retention_purge": {
        "system": (_is_identifier, True),
        "criteria": (_is_identifier, True),
    },
    "data.portability_export": {
        "system": (_is_identifier, True),
        "destination": (_is_identifier, True),
    },
    # Policy / documentation: which document, to what version.
    "policy.publish": {"document": (_is_identifier, True), "version": (_is_identifier, False)},
    "policy.update": {"document": (_is_identifier, True), "version": (_is_identifier, False)},
    "notice.update": {"document": (_is_identifier, True), "version": (_is_identifier, False)},
    "consent.update": {"document": (_is_identifier, True), "version": (_is_identifier, False)},
    # System configuration.
    "config.rbac_update": {
        "role": (_is_identifier, True),
        "grant_permissions": (_is_optional_identifier_list, False),
        "revoke_permissions": (_is_optional_identifier_list, False),
    },
    "config.mfa_enforce": {
        "scope": (lambda v: v in ("tenant", "role"), True),
        "role": (_is_identifier, False),
    },
    "config.backup_encrypt": {"enabled": (lambda v: isinstance(v, bool), True)},
    "config.audit_log_enable": {"enabled": (lambda v: isinstance(v, bool), True)},
    "config.consent_ui_update": {"surface": (_is_identifier, True)},
    # Governance / process: record-shaped, field names only.
    "dpo.appoint": {"fields": (_is_identifier_list, True)},
    "dpo.contact_publish": {"fields": (_is_identifier_list, True)},
    "dpa.execute": {"counterparty": (_is_identifier, True)},
    "breach.playbook_publish": {"playbook": (_is_identifier, True)},
    "training.run": {"programme": (_is_identifier, True), "audience": (_is_identifier, False)},
    "review.accept_risk": {"finding": (_is_identifier, True)},
    # Connector-driven reads: no mutation of the client estate.
    "connector.scan": {"system": (_is_identifier, True)},
    "connector.classify": {"system": (_is_identifier, True)},
}


def _validate_parameters(
    action_type: str, parameters: dict[str, Any]
) -> str | None:
    """Return a refusal code, or None when the parameters fit the spec."""
    if not isinstance(parameters, dict):
        return "parameters_invalid"
    try:
        if len(json.dumps(parameters).encode("utf-8")) > MAX_PARAMETERS_BYTES:
            return "parameters_oversized"
    except (TypeError, ValueError):
        return "parameters_invalid"
    spec = _PARAMETER_SPECS.get(action_type)
    if spec is None:
        return "action_type_not_simulable"
    for key, (check, required) in spec.items():
        value = parameters.get(key)
        if value is None:
            if required:
                return "parameters_invalid"
            continue
        if not check(value):
            return "parameters_invalid"
    extra = set(parameters) - set(spec)
    if extra:
        return "parameters_invalid"
    return None


def _render_diff(
    action_type: str,
    parameters: dict[str, Any],
    blast_radius: dict[str, Any],
    rollback_definition: dict[str, Any],
) -> dict[str, Any]:
    """Render the structured diff for an already-validated action."""
    records = _declared_records(blast_radius)
    records_declared = records is not None
    changes: list[dict[str, Any]] = []
    targets: list[dict[str, Any]] = []

    if action_type == "data.mask":
        targets.append({"system": parameters["system"], "records": records})
        for field in parameters["fields"]:
            changes.append(
                {
                    "field": field,
                    "before": "value_as_stored",
                    "after": "masked",
                    "records_affected": records,
                }
            )
    elif action_type in ("data.delete", "data.retention_purge"):
        targets.append({"system": parameters["system"], "records": records})
        changes.append(
            {
                "records_affected": records,
                "before": "present",
                "after": "deleted",
                "basis": parameters.get("criteria", "declared"),
            }
        )
    elif action_type == "data.portability_export":
        targets.append({"system": parameters["system"], "records": records})
        changes.append(
            {
                "records_affected": records,
                "before": "stored",
                "after": "exported",
                "destination": parameters["destination"],
            }
        )
    elif action_type in ("policy.publish", "policy.update", "notice.update", "consent.update"):
        document = parameters["document"]
        targets.append({"document": document})
        changes.append(
            {
                "field": "document_version",
                "before": "as_published",
                "after": parameters.get("version", "draft"),
            }
        )
    elif action_type == "config.rbac_update":
        role = parameters["role"]
        targets.append({"role": role})
        for permission in parameters.get("grant_permissions") or []:
            changes.append(
                {"field": permission, "before": "absent", "after": "granted", "role": role}
            )
        for permission in parameters.get("revoke_permissions") or []:
            changes.append(
                {"field": permission, "before": "granted", "after": "revoked", "role": role}
            )
    elif action_type == "config.mfa_enforce":
        scope = parameters["scope"]
        targets.append({"scope": scope, **({"role": parameters["role"]} if scope == "role" else {})})
        changes.append({"field": "mfa_enforced", "before": "undeclared", "after": True})
    elif action_type in ("config.backup_encrypt", "config.audit_log_enable"):
        setting = "backup_encrypted" if action_type == "config.backup_encrypt" else "audit_log_enabled"
        changes.append({"field": setting, "before": "undeclared", "after": parameters["enabled"]})
    elif action_type == "config.consent_ui_update":
        targets.append({"surface": parameters["surface"]})
        changes.append(
            {"field": "consent_ui", "before": "as_deployed", "after": parameters["surface"]}
        )
    elif action_type in ("dpo.appoint", "dpo.contact_publish"):
        # Field names only: the record's identity values stay in the
        # action parameters the approver reads; the diff stays metadata.
        for field in parameters["fields"]:
            changes.append({"field": field, "before": "absent", "after": "recorded"})
    elif action_type == "dpa.execute":
        changes.append(
            {"field": "dpa", "before": "absent", "after": parameters["counterparty"]}
        )
    elif action_type == "breach.playbook_publish":
        changes.append(
            {"field": "breach_playbook", "before": "absent", "after": parameters["playbook"]}
        )
    elif action_type == "training.run":
        changes.append(
            {
                "field": "training",
                "before": "not_run",
                "after": parameters["programme"],
                **({"audience": parameters["audience"]} if parameters.get("audience") else {}),
            }
        )
    elif action_type == "review.accept_risk":
        changes.append(
            {
                "field": "risk_acceptance",
                "before": "open",
                "after": "accepted",
                "finding": parameters["finding"],
            }
        )
    elif action_type in ("connector.scan", "connector.classify"):
        # Read-only: the honest diff is an empty change set, stated as such.
        targets.append({"system": parameters["system"]})
    else:  # pragma: no cover - validate_parameters refuses unknown types first
        raise ValueError(action_type)

    return {
        "renderable": True,
        "action_type": action_type,
        "simulated_from": "declared_parameters",
        "records_declared": records_declared,
        "targets": targets,
        "changes": changes,
        "rollback": _rollback_fact(rollback_definition),
    }


def simulate(
    action_type: str,
    parameters: dict[str, Any],
    blast_radius: dict[str, Any],
    rollback_definition: dict[str, Any],
) -> DryRunOutcome:
    """Simulate one action, or refuse it.

    A refusal means the action is not eligible for agent execution and
    routes to manual handling (Doc 04 §3.2). A failure means the engine
    itself could not complete — also recorded, never swallowed.
    """
    try:
        if not isinstance(blast_radius, dict) or not isinstance(rollback_definition, dict):
            return DryRunOutcome("refused", None, "parameters_invalid")
        refusal = _validate_parameters(action_type, parameters)
        if refusal is not None:
            return DryRunOutcome("refused", None, refusal)
        diff = _render_diff(action_type, parameters, blast_radius, rollback_definition)
        return DryRunOutcome("succeeded", diff, None)
    except Exception:
        return DryRunOutcome("failed", None, "simulation_error")
