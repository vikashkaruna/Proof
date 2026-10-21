"""Opt-in local identity recovery under a finite, immutable human approval.

Called only by the existing renewal runner while its entire-cycle lock is held.
No browser session, business decision, role, policy, or namespace is created.
"""
from __future__ import annotations

import importlib.util
import json
import secrets
import time
from pathlib import Path


def module(config: dict, filename: str):
    path = Path(config["workspace"]) / "scripts" / filename
    spec = importlib.util.spec_from_file_location("approved_" + filename.replace("-", "_"), path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    if filename == "local-spire.py":result.CACHE = Path(config["spireCache"])
    return result


def scope(config: dict, deployments: dict, api) -> dict:
    """Bind stable approved policy/config bytes, never expiring bearer bytes."""
    root = Path(config["environment"]["AXIOM_LOCAL_CONTROLLER_DIR"])
    custody_root = Path(config["environment"]["AXIOM_LOCAL_CUSTODY_ISSUER_DIR"])
    custody = module(config, "local-custody-credentials.py")
    result = {"settings": {}, "tenants": {}}
    for name, path in (("controller", root / "settings.json"), ("custody", custody_root / "settings.json")):
        result["settings"][name] = api.digest(api.read_private(path))
    for alias in config["tenants"]:
        tenant = deployments[alias].tenant_id
        policy = custody.active_policy(tenant)
        current = json.loads(api.read_private(root / alias / "credentials/current.json"))
        base = custody_root / "credentials" / tenant
        kinds = [kind for kind in ("operator", "producer", "controller") if (base / (kind + ".last")).exists()]
        if not kinds or current["tenantId"] != tenant:
            raise ValueError("Existing approved credentials required")
        # Issuers validate the actual signed request and activation again at issue time.
        result["tenants"][alias] = {
            "tenantId": tenant, "policySha256": policy["policySha256"],
            "activationEventId": policy["activationEventId"], "epoch": policy["epoch"],
            "controllerApprovalReference": current["approvalReference"], "custodyKinds": kinds,
            "runtimeSha256": api.digest(api.read_private(root / alias / "runtime.json")),
        }
        api.validate_runtime_images(config, alias)
    return result


def capture(config: dict, deployments: dict, reference: str, days: int, api) -> dict:
    if not isinstance(reference, str) or not 8 <= len(reference) <= 256 or not 1 <= days <= 30:
        raise ValueError("Recorded approval and bounded local review period required")
    spire = module(config, "local-spire.py")
    spire.private_path(spire.CACHE, directory=True)
    meta = spire.container_meta(spire.NAME)
    if meta is None or not meta["State"]["Running"]:
        raise ValueError("Existing healthy SPIRE required at approval")
    if api.run([config["dockerExecutable"], "exec", spire.NAME, "spire-agent", "healthcheck", "-socketPath", "/run/workload/api.sock"], env=config["environment"]):
        raise ValueError("Healthy attestation required at approval")
    old = spire.node_id()
    entries = spire.entries()
    spire.reviewed_roles(old, entries)
    now = int(time.time())
    return {"schemaVersion": 1, "purpose": "local-existing-runtime-identity-recovery", "approvalReference": reference,
            "approvedAt": now, "expiresAt": now + days * 86400, "maxPer24Hours": 4,
            "scope": scope(config, deployments, api), "spireImage": meta["Image"],
            "spireGrantsSha256": spire.grants_sha256(entries)}


def save(path: Path, value: dict, api) -> None:
    temporary = path.with_name(path.name + ".next")
    if temporary.exists() or temporary.is_symlink():
        api.owned(temporary); temporary.unlink()
    api.write_private(temporary, json.dumps(value, sort_keys=True).encode())
    if path.exists() or path.is_symlink():api.owned(path)
    temporary.replace(path)


def check_policy(config: dict, deployments: dict, state: Path, api) -> dict | None:
    policy = config.get("localRecovery")
    if policy is None:return None
    if (state / "recovery.disabled").exists() or (state / "recovery.disabled").is_symlink():
        api.owned(state / "recovery.disabled")
        return None
    now = int(time.time())
    if (policy.get("schemaVersion") != 1 or policy.get("purpose") != "local-existing-runtime-identity-recovery"
        or policy.get("maxPer24Hours") != 4 or type(policy.get("approvedAt")) is not int
        or type(policy.get("expiresAt")) is not int or not policy["approvedAt"] <= now < policy["expiresAt"]
        or not 86400 <= policy["expiresAt"] - policy["approvedAt"] <= 30 * 86400
        or scope(config, deployments, api) != policy["scope"]):
        raise ValueError("Local recovery approval expired or scope changed; review and reinstall")
    return policy


def journal(state: Path, api) -> dict:
    path = state / "recovery.json"
    value = json.loads(api.read_private(path)) if path.exists() else {"schemaVersion": 1, "events": [], "pending": None}
    if value.get("schemaVersion") != 1 or not isinstance(value.get("events"), list):
        raise ValueError("Protected recovery journal refused")
    return value


def begin(value: dict, key: str, state: Path, api) -> dict:
    if value["pending"] is not None:
        if value["pending"]["component"] != key:raise ValueError("Different unresolved recovery requires review")
        return value["pending"]
    now = int(time.time())
    recent = [e for e in value["events"] if e["component"] == key and e["at"] > now - 86400]
    if len(recent) >= 4:raise ValueError("Local recovery rate limit; review required")
    pending = {"component": key, "at": now, "phase": "planned"}
    value["pending"] = pending
    value["events"].append({"component": key, "at": now})
    save(state / "recovery.json", value, api)
    return pending


def command(config: dict, filename: str, *args: str) -> list[str]:
    return [config["python"], "-I", str(Path(config["workspace"]) / "scripts" / filename), *args]


def checked(config: dict, args: list[str], api, timeout: int = 420, *, state: Path, deployments: dict) -> None:
    # Opt-out/expiry/worker activity is rechecked before EVERY mutating helper.
    if check_policy(config, deployments, state, api) is None:
        raise ValueError("Local recovery disabled")
    api.validate_sources(config)
    if api.worker_idle_state(config) != "idle":raise ValueError("Worker activity defers recovery")
    api.stable_bff(config)
    if api.run(args, env=config["environment"], timeout=timeout):
        raise ValueError("Local recovery incomplete; same request retained")


def recover(config: dict, deployments: dict, state: Path, api) -> list[dict]:
    # Docker/startup unavailability does not consume recovery quota.
    if config.get("localRecovery") is None:return []
    if api.run([config["dockerExecutable"], "info", "--format", "{{.ServerVersion}}"], env=config["environment"]):
        return [{"component": "localRecovery", "ok": False, "deferredForDocker": True}]
    policy = check_policy(config, deployments, state, api)
    if policy is None:return []
    if api.worker_idle_state(config) != "idle":
        return [{"component": "localRecovery", "ok": False, "deferredForWorkers": True}]
    before, network = api.stable_bff(config)
    record = journal(state, api)
    approval_sha = api.digest(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode())
    if record.get("approvalSha256", approval_sha) != approval_sha:
        raise ValueError("Recovery journal belongs to a different standing approval")
    record["approvalSha256"] = approval_sha
    record["approvalReference"] = policy["approvalReference"]
    for peer in config["runtimeBindings"]["peers"]:
        names = api.docker_read(config, ["ps", "-a", "--format", "{{.Names}}"]).splitlines()
        if peer["name"] not in names:
            pending = record.get("pending") or {}
            if ((pending.get("component") == peer.get("tenant") and pending.get("phase") == "restaging" and peer["kind"] in ("controller", "scheduler"))
                or (record.get("producerPhase") in ("removing", "staging", "serving") and peer["kind"] == "producer")):
                continue  # Exact owned restaging can remove these known peers.
            raise ValueError("Approved runtime peer missing outside recorded restaging")
        observed = api.metadata(config, peer["name"], peer["purpose"])
        if observed["image"] != peer["image"] or observed["network"] != "container:" + before["id"]:
            raise ValueError("Approved peer identity/image/network changed")
    spire = module(config, "local-spire.py")
    meta = spire.container_meta(spire.NAME)
    if meta is None or meta["Image"] != policy["spireImage"]:
        raise ValueError("Approved SPIRE image changed")
    outcomes = []
    # Existing uncertain journals always take precedence over another token.
    unfinished = []
    for path in spire.CACHE.glob("recovery-*/intent.json"):
        item = json.loads(api.read_private(path))
        if item["phase"] != spire.COMPLETE:unfinished.append((path, item))
    if len(unfinished) > 1:raise ValueError("Multiple unresolved SPIRE recoveries require review")
    healthy = api.run([config["dockerExecutable"], "exec", spire.NAME, "spire-agent", "healthcheck", "-socketPath", "/run/workload/api.sock"], env=config["environment"]) == 0
    if healthy and spire.grants_sha256(spire.entries()) != policy["spireGrantsSha256"]:
        raise ValueError("Approved registration snapshot changed")
    if not healthy or unfinished:
        if not unfinished:
            spire.expired_node_proof(meta)  # Proof precedes any quota reservation.
        pending = begin(record, "spire", state, api)
        if unfinished:
            path, intent = unfinished[0]
            if (intent.get("approvedRecoveryImage") != policy["spireImage"] or intent.get("expectedGrantsSha256") != policy["spireGrantsSha256"] or intent["phase"] == "token_issuing"):
                raise ValueError("Uncertain or unapproved SPIRE recovery requires operator review")
            args = command(config, "local-spire.py", "reattest", "--resume", str(path), "--cache-dir", config["spireCache"])
        else:
            if pending["phase"] != "planned":raise ValueError("Unresolved SPIRE outcome requires review")
            pending["phase"] = "invoking"; save(state / "recovery.json", record, api)
            args = command(config, "local-spire.py", "reattest", "--expired-agent", "--recovery-image", policy["spireImage"], "--expected-grants-sha256", policy["spireGrantsSha256"], "--cache-dir", config["spireCache"])
        checked(config, args, api, 540, state=state, deployments=deployments)
        record.update(pending=None, restageTenants=list(config["tenants"]), producerPhase="needed")
        save(state / "recovery.json", record, api)
        outcomes.append({"component": "spireRecovery", "ok": True})
    elif record["pending"] and record["pending"]["component"] == "spire":
        # A completed journal proves the exact operation, never health alone.
        completed = [json.loads(api.read_private(p)) for p in spire.CACHE.glob("recovery-*/intent.json")]
        if not any(v.get("phase") == spire.COMPLETE and v.get("expectedGrantsSha256") == policy["spireGrantsSha256"] and any(h["at"] >= record["pending"]["at"] for h in v.get("history", [])) for v in completed):
            raise ValueError("Unconfirmed SPIRE outcome requires review")
        record.update(pending=None, restageTenants=list(config["tenants"]), producerPhase="needed")
        save(state / "recovery.json", record, api)
    if record.get("producerPhase") in ("stopping", "removing", "staging", "serving"):
        restore_producer(config, deployments, state, api, record, before, network)
    # The SPIRE node may have changed. Existing staged services must be rebuilt
    # from approved runtime bytes, regardless of remaining credential lifetime.
    bool(record.get("restageTenants"))
    for alias in config["tenants"]:
        tenant_scope = policy["scope"]["tenants"][alias]
        tenant = tenant_scope["tenantId"]
        root = Path(config["environment"]["AXIOM_LOCAL_CONTROLLER_DIR"])
        custody = Path(config["environment"]["AXIOM_LOCAL_CUSTODY_ISSUER_DIR"]) / "credentials" / tenant
        needed = alias in record.get("restageTenants", []) or not all(api.unexpired(config, alias, tenant, kind) for kind in ("controller", "custody"))
        if not needed and not (record["pending"] and record["pending"]["component"] == alias):continue
        pending = begin(record, alias, state, api)
        if "credentials" not in pending:
            pending["credentials"] = {kind: api.read_private(custody / (kind + ".last")).decode().strip() for kind in tenant_scope["custodyKinds"]}
            pending["controllerId"] = json.loads(api.read_private(root / alias / "credentials/current.json"))["credentialId"]
            save(state / "recovery.json", record, api)
        for kind, previous in pending["credentials"].items():
            pointer = api.read_private(custody / (kind + ".last")).decode().strip()
            unresolved = custody / (kind + ".pending.json")
            if pointer == previous or unresolved.exists():
                resume = json.loads(api.read_private(unresolved))["credentialId"] if unresolved.exists() else None
                checked(config, command(config, "local-custody-credentials.py", "issue", "--tenant-id", tenant, "--kind", kind, *(["--resume", resume] if resume else [])), api, state=state, deployments=deployments)
        current = json.loads(api.read_private(root / alias / "credentials/current.json"))
        unresolved = root / alias / "credentials/pending.json"
        if current["credentialId"] == pending["controllerId"] or unresolved.exists():
            resume = json.loads(api.read_private(unresolved))["credentialId"] if unresolved.exists() else None
            checked(config, command(config, "local-assessment-controller.py", "issue", "--tenant", alias, "--approval-reference", tenant_scope["controllerApprovalReference"], *(["--resume", resume] if resume else [])), api, state=state, deployments=deployments)
        pending["phase"] = "restaging"; save(state / "recovery.json", record, api)
        runtime = json.loads(api.read_private(root / alias / "runtime.json"))
        peers = config["runtimeBindings"]["peers"]
        key = next(p for p in peers if p["kind"] == "key" and p["tenant"] == alias)
        checked(config, api.repair_command(config, key, "serve"), api, state=state, deployments=deployments)
        stage = command(config, "local-assessment-controller.py", "stage", "--tenant", alias)
        for flag, field in (("controller-image", "controllerImage"), ("worker-image", "workerImage"), ("scheduler-image", "schedulerImage"), ("namespace", "namespace"), ("temporal-address", "temporalAddress"), ("supabase-url", "supabaseUrl"), ("docker-gid", "dockerGid")):
            stage.extend(["--" + flag, str(runtime[field])])
        if runtime.get("monitoringReadDispatch", False):stage.append("--monitoring-read-dispatch")
        checked(config, stage, api, state=state, deployments=deployments)
        for action in ("check", "serve", "scheduler"):
            checked(config, command(config, "local-assessment-controller.py", action, "--tenant", alias), api, state=state, deployments=deployments)
        if api.stable_bff(config) != (before, network):raise ValueError("BFF changed during recovery")
        record["pending"] = None
        record["producerPhase"] = "needed"
        record["restageTenants"] = [item for item in record.get("restageTenants", []) if item != alias]
        save(state / "recovery.json", record, api)
        outcomes.append({"component": "identityRecovery", "tenant": alias, "ok": True})
    if record.get("producerPhase"):
        restore_producer(config, deployments, state, api, record, before, network)
    return outcomes


def restore_producer(config: dict, deployments: dict, state: Path, api, record: dict, before: dict, network: str) -> None:
    producer = next(p for p in config["runtimeBindings"]["peers"] if p["kind"] == "producer")
    def observed():
        names = api.docker_read(config, ["ps", "-a", "--format", "{{.Names}}"]).splitlines()
        if producer["name"] not in names:return None
        value = api.metadata(config, producer["name"], producer["purpose"])
        if value["image"] != producer["image"] or value["network"] != "container:" + before["id"]:
            raise ValueError("Producer image/network changed")
        return value
    def checkpoint(phase):
        record["producerPhase"] = phase; save(state / "recovery.json", record, api)
    current = observed()
    if record["producerPhase"] == "needed":
        if current is None:raise ValueError("Existing producer required before authorized stop")
        begin(record, "producer", state, api)
        record["producerOldId"] = current["id"]
        record["producerOwner"] = secrets.token_hex(16)
        checkpoint("stopping")
    if record["producerPhase"] == "stopping":
        if current is None or current["id"] != record["producerOldId"]:
            raise ValueError("Original producer identity changed before stop")
        if current["running"]:
            checked(config, [config["dockerExecutable"], "stop", "--time", "95", current["id"]], api, state=state, deployments=deployments)
        current = observed()
        if current is None or current["id"] != record["producerOldId"] or current["running"]:
            raise ValueError("Original producer stop unconfirmed")
        checkpoint("removing")
    if record["producerPhase"] == "removing":
        current = observed()
        if current is not None:
            if current["id"] != record["producerOldId"] or current["running"]:
                raise ValueError("Foreign or restarted producer will not be removed")
            checked(config, [config["dockerExecutable"], "rm", current["id"]], api, state=state, deployments=deployments)
        if observed() is not None:raise ValueError("Original producer removal unconfirmed")
        checkpoint("staging")
    if record["producerPhase"] == "staging":
        if observed() is not None:raise ValueError("Producer name must remain absent while staging")
        checked(config, api.repair_command(config, producer, "stage"), api, state=state, deployments=deployments)
        checkpoint("serving")
    if record["producerPhase"] == "serving":
        current = observed()
        if current is None:
            args = [*api.repair_command(config, producer, "serve"), "--recovery-owner", record["producerOwner"]]
            checked(config, args, api, state=state, deployments=deployments)
            current = observed()
        if (current is None or current.get("labels", {}).get("axiom.recovery.owner") != record["producerOwner"]
            or not current["running"] or api.namespace(config, current, "node") != network):
            raise ValueError("Owned replacement producer readiness unconfirmed")
        if api.stable_bff(config) != (before, network):raise ValueError("BFF changed during producer recovery")
        if (record.get("pending") or {}).get("component") != "producer":
            raise ValueError("Producer recovery reservation changed")
        record.update(producerPhase=None, producerNewId=current["id"], pending=None)
        save(state / "recovery.json", record, api)
