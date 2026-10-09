#!/usr/bin/env python3
"""Read-only, fail-closed inventory for first marketing lifecycle-state adoption.

This is a bounded observation, not a lock. The seed coordinator deliberately
does not consume it yet: a real inspection Job and race-closing rollout protocol
must be reviewed before that gate can be enabled.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess  # nosec B404
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

# Subprocess use is limited to validated, fixed read-only gcloud commands.

SHA40 = re.compile(r"[a-f0-9]{40}\Z")
NAME = re.compile(r"[a-z][a-z0-9-]{4,62}\Z")
REGION = re.compile(r"[a-z]+-[a-z0-9]+[0-9]\Z")
EXECUTION = re.compile(r"[a-z][a-z0-9-]{4,62}\Z")
MAX_JSON_BYTES = 2_000_000
MAX_LOG_AGE_SECONDS = 300
RFC1918 = tuple(
    ipaddress.IPv4Network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


def protected_json(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.name.endswith(".example"):
        raise ValueError("Protected input unavailable")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("Protected input permissions too broad")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError("Protected input must be an object")
    return value


def read_json(argv: list[str]) -> object:
    # Caller supplies fixed read-only gcloud argv.
    result = subprocess.run(  # nosec B603
        argv, capture_output=True, timeout=25, check=False
    )
    if result.returncode or len(result.stdout) > MAX_JSON_BYTES:
        raise ValueError("Read-only cloud inventory unavailable")
    try:
        return json.loads(result.stdout)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Malformed cloud inventory") from error


def cloud_get(args: list[str], project: str) -> object:
    return read_json(
        [gcloud_bin(), *args, "--project", project, "--format=json", "--quiet"]
    )


def gcloud_bin() -> str:
    found = shutil.which("gcloud")
    if found is None:
        raise ValueError("Google Cloud CLI unavailable")
    executable = Path(found).resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("Google Cloud CLI unavailable")
    return str(executable)


def monitoring_instances(project: str, service: str, now: int) -> dict:
    """Fetch supporting instance-count samples, never a live exclusion lock."""
    # Fixed token-read command and validated project.
    result = subprocess.run(  # nosec B603
        [gcloud_bin(), "auth", "print-access-token", "--project", project],
        capture_output=True,
        timeout=15,
        check=False,
    )
    token = result.stdout.strip()
    if result.returncode or not re.fullmatch(rb"[A-Za-z0-9._~+/-]{20,16384}", token):
        raise ValueError("Monitoring identity unavailable")
    query = urlencode(
        {
            "filter": (
                'metric.type="run.googleapis.com/container/instance_count" '
                'AND resource.type="cloud_run_revision" '
                f'AND resource.labels.service_name="{service}"'
            ),
            "interval.startTime": datetime.fromtimestamp(
                now - 600, tz=timezone.utc
            ).isoformat(),
            "interval.endTime": datetime.fromtimestamp(
                now, tz=timezone.utc
            ).isoformat(),
            "view": "FULL",
            "pageSize": "100",
        }
    )
    endpoint = (
        f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?{query}"
    )

    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            raise ValueError("Monitoring redirect refused")

    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(
        Request(endpoint, headers={"Authorization": "Bearer " + token.decode("ascii")}),
        timeout=15,
    ) as response:
        raw = response.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("Monitoring response too large")
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("nextPageToken"):
        raise ValueError("Monitoring response incomplete")
    return data


def exact_name(resource: dict, expected: str) -> bool:
    name = resource.get("name")
    return isinstance(name, str) and (name == expected or name.endswith("/" + expected))


def same_network(value: object, name: str) -> bool:
    return isinstance(value, str) and (
        value == name or value.endswith("/networks/" + name)
    )


def validate_external_clients(
    inventory: dict, *, network: str, subnet: str, auth: str, job: str, region: str
) -> None:
    peers = inventory["peerings"]
    require(
        isinstance(peers, list)
        and len(peers) == 1
        and isinstance(peers[0], dict)
        and peers[0].get("name") == "servicenetworking-googleapis-com"
        and peers[0].get("state") == "ACTIVE",
        "Dedicated VPC peering differs from private service access",
    )
    routes = inventory["routes"]
    require(isinstance(routes, list), "VPC route inventory unavailable")
    for route in routes:
        require(
            isinstance(route, dict)
            and same_network(route.get("network"), network)
            and str(route.get("nextHopGateway", "")).endswith(
                "/global/gateways/default-internet-gateway"
            ),
            "Unexpected VPC route to another client network",
        )
    instances = inventory["compute_instances"]
    require(isinstance(instances, list), "Compute VM inventory unavailable")
    for vm in instances:
        interfaces = vm.get("networkInterfaces") if isinstance(vm, dict) else None
        require(
            isinstance(interfaces, list)
            and all(
                isinstance(item, dict) and isinstance(item.get("network"), str)
                for item in interfaces
            ),
            "Unknown Compute VM network attachment",
        )
        require(
            not any(same_network(item.get("network"), network) for item in interfaces),
            "Compute VM attached to marketing VPC",
        )
    clusters = inventory["gke_clusters"]
    require(isinstance(clusters, list), "GKE cluster inventory unavailable")
    for cluster in clusters:
        require(
            isinstance(cluster, dict) and isinstance(cluster.get("network"), str),
            "Unknown GKE network attachment",
        )
        require(
            not same_network(cluster["network"], network),
            "GKE cluster attached to marketing VPC",
        )
    connectors = inventory["connectors_by_region"]
    require(
        isinstance(connectors, dict) and connectors,
        "Cross-region VPC connector inventory unavailable",
    )
    for items in connectors.values():
        require(isinstance(items, list), "VPC connector region unavailable")
        for connector in items:
            require(isinstance(connector, dict), "Malformed VPC connector")
            # A connector may use an existing subnet instead of a network.
            attached = connector.get("network")
            attached_subnet = connector.get("subnet", {})
            require(
                isinstance(attached, str)
                or (
                    isinstance(attached_subnet, dict)
                    and isinstance(attached_subnet.get("name"), str)
                ),
                "Unknown VPC connector attachment",
            )
            require(
                not same_network(attached, network)
                and not (
                    isinstance(attached_subnet, dict)
                    and (
                        attached_subnet.get("name") == subnet
                        or str(attached_subnet.get("name", "")).endswith(
                            "/subnetworks/" + subnet
                        )
                    )
                ),
                "VPC connector attached to marketing VPC",
            )
    services = inventory["services_by_region"]
    jobs = inventory["jobs_by_region"]
    revisions = inventory["revisions_by_region"]
    all_executions = inventory["executions_by_region"]
    require(
        isinstance(services, dict)
        and isinstance(jobs, dict)
        and isinstance(revisions, dict)
        and isinstance(all_executions, dict)
        and services
        and set(services) == set(jobs) == set(revisions) == set(all_executions)
        and region in services,
        "Cross-region Cloud Run inventory unavailable",
    )
    found_auth = 0
    found_job = 0
    for location, items in services.items():
        require(isinstance(items, list), "Cloud Run service region unavailable")
        for service in items:
            require(
                isinstance(service, dict) and isinstance(service.get("name"), str),
                "Malformed Cloud Run service",
            )
            if exact_name(service, auth):
                found_auth += 1
                require(location == region, "GoTrue appears in a foreign region")
                continue
            template = service.get("template", {})
            require(isinstance(template, dict), "Unknown Cloud Run service template")
            vpc = template.get("vpcAccess", {})
            require(isinstance(vpc, dict), "Unknown Cloud Run service VPC")
            interfaces = vpc.get("networkInterfaces", [])
            require(
                isinstance(interfaces, list)
                and all(
                    isinstance(item, dict) and isinstance(item.get("network"), str)
                    for item in interfaces
                ),
                "Unknown Cloud Run service VPC interface",
            )
            require(
                not vpc.get("connector")
                and not any(
                    same_network(item.get("network"), network) for item in interfaces
                ),
                "Other Cloud Run service attached to marketing VPC",
            )
    for location, items in jobs.items():
        require(isinstance(items, list), "Cloud Run Job region unavailable")
        for run_job in items:
            require(
                isinstance(run_job, dict) and isinstance(run_job.get("name"), str),
                "Malformed Cloud Run Job",
            )
            if exact_name(run_job, job):
                found_job += 1
                require(location == region, "Migration Job appears in a foreign region")
                continue
            outer = run_job.get("template", {})
            inner = outer.get("template", {}) if isinstance(outer, dict) else None
            require(isinstance(inner, dict), "Unknown Cloud Run Job template")
            vpc = inner.get("vpcAccess", {})
            require(isinstance(vpc, dict), "Unknown Cloud Run Job VPC")
            interfaces = vpc.get("networkInterfaces", [])
            require(
                isinstance(interfaces, list)
                and all(
                    isinstance(item, dict) and isinstance(item.get("network"), str)
                    for item in interfaces
                ),
                "Unknown Cloud Run Job VPC interface",
            )
            require(
                not vpc.get("connector")
                and not any(
                    same_network(item.get("network"), network) for item in interfaces
                ),
                "Other Cloud Run Job attached to marketing VPC",
            )
    require(
        found_auth == found_job == 1,
        "Expected one GoTrue service and one migration Job project-wide",
    )
    for location, items in revisions.items():
        require(isinstance(items, list), "Cloud Run revision region unavailable")
        for revision in items:
            require(
                isinstance(revision, dict) and isinstance(revision.get("service"), str),
                "Unknown Cloud Run revision owner",
            )
            if exact_name({"name": revision["service"]}, auth):
                require(
                    location == region, "GoTrue revision appears in a foreign region"
                )
                continue
            vpc = revision.get("vpcAccess", {})
            require(isinstance(vpc, dict), "Unknown Cloud Run revision VPC")
            interfaces = vpc.get("networkInterfaces", [])
            require(
                isinstance(interfaces, list)
                and all(
                    isinstance(item, dict) and isinstance(item.get("network"), str)
                    for item in interfaces
                ),
                "Unknown Cloud Run revision VPC interface",
            )
            require(
                not vpc.get("connector")
                and not any(
                    same_network(item["network"], network) for item in interfaces
                ),
                "Older Cloud Run revision can reach marketing VPC",
            )
    for items in all_executions.values():
        require(isinstance(items, list), "Cloud Run execution region unavailable")
        require(
            all(
                isinstance(item, dict) and item.get("completionTime") for item in items
            ),
            "A Cloud Run Job execution is still active",
        )


def region_names(items: object) -> list[str]:
    require(isinstance(items, list) and items, "Cloud region inventory unavailable")
    names = []
    for item in items:
        value = item.get("name") if isinstance(item, dict) else None
        name = value.rsplit("/", 1)[-1] if isinstance(value, str) else ""
        require(REGION.fullmatch(name) is not None, "Malformed cloud region")
        names.append(name)
    require(len(names) == len(set(names)), "Duplicate cloud region inventory")
    return sorted(names)


def timestamp(value: str) -> int:
    if not isinstance(value, str):
        raise TypeError("Missing observation timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Malformed observation timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("Unzoned observation timestamp")
    return int(parsed.timestamp())


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def verify_zero_instance_metric(metric: object, *, service: str, now: int) -> int:
    """Require two recent zero points as supporting, historical evidence."""
    require(
        isinstance(metric, dict) and not metric.get("nextPageToken"),
        "Incomplete Cloud Monitoring data",
    )
    series = metric.get("timeSeries")
    require(isinstance(series, list) and series, "GoTrue instance metric unavailable")
    points: dict[int, int] = {}
    for item in series:
        require(isinstance(item, dict), "Malformed GoTrue instance series")
        resource = item.get("resource", {})
        labels = resource.get("labels", {}) if isinstance(resource, dict) else {}
        require(
            item.get("metric", {}).get("type")
            == "run.googleapis.com/container/instance_count"
            and resource.get("type") == "cloud_run_revision"
            and labels.get("service_name") == service,
            "GoTrue metric scope differs",
        )
        for point in item.get("points", []):
            when = timestamp(point.get("interval", {}).get("endTime"))
            value = point.get("value", {}).get("int64Value")
            require(
                isinstance(value, str) and re.fullmatch(r"[0-9]+", value) is not None,
                "GoTrue instance count malformed",
            )
            points[when] = points.get(when, 0) + int(value)
    recent = sorted((when for when in points if 0 <= now - when <= 180), reverse=True)
    require(
        len(recent) >= 2
        and 30 <= recent[0] - recent[1] <= 120
        and points[recent[0]] == points[recent[1]] == 0,
        "GoTrue zero-instance observations missing or stale",
    )
    return recent[0]


def verify_inspection_log(
    entries: object,
    *,
    project: str,
    region: str,
    job: str,
    execution: str,
    release: str,
    database: str,
    start: int,
    finish: int,
    now: int,
) -> dict:
    require(
        isinstance(entries, list) and len(entries) < 100,
        "Incomplete inspection log inventory",
    )
    matching: list[dict] = []
    for entry in entries:
        require(isinstance(entry, dict), "Malformed inspection log entry")
        resource = entry.get("resource", {})
        labels = resource.get("labels", {}) if isinstance(resource, dict) else {}
        top_labels = entry.get("labels", {})
        if not isinstance(labels, dict) or not isinstance(top_labels, dict):
            raise TypeError("Malformed inspection log labels")
        if (
            resource.get("type") != "cloud_run_job"
            or labels.get("project_id") != project
            or labels.get("location") != region
            or labels.get("job_name") != job
            or top_labels.get("execution_name") != execution
            or entry.get("logName")
            != f"projects/{project}/logs/run.googleapis.com%2Fstdout"
        ):
            raise ValueError("Inspection log escaped exact execution scope")
        observed = timestamp(entry.get("timestamp"))
        require(
            start <= observed <= finish <= now
            and finish - observed <= 30
            and now - observed <= MAX_LOG_AGE_SECONDS,
            "Inspection log not fresh within completed execution",
        )
        payload = entry.get("textPayload")
        if not isinstance(payload, str):
            continue
        try:
            message = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(message, dict)
            and message.get("kind") == "marketing-database-client-inspection"
        ):
            matching.append(message)
    require(len(matching) == 1, "One exact inspection receipt required")
    receipt = matching[0]
    facts = receipt.get("facts")
    require(
        receipt.get("release_sha") == release and isinstance(facts, dict),
        "Inspection release or facts mismatch",
    )
    require(
        facts.get("database") == database and facts.get("encrypted_transport") is True,
        "Inspection database or TLS mismatch",
    )
    require(
        facts.get("observer_superuser") is True
        or facts.get("observer_can_read_all_stats") is True,
        "Inspector cannot prove complete client visibility",
    )
    require(facts.get("clients") == [], "Database still has client sessions")
    require(
        isinstance(facts.get("auth_migrations"), int) and facts["auth_migrations"] > 0,
        "GoTrue bootstrap not observed",
    )
    require(
        isinstance(facts.get("application_migrations"), int)
        and facts["application_migrations"] >= 119,
        "Application migrations not observed",
    )
    return facts


def validate(
    env: dict[str, str],
    release: dict,
    inventory: dict,
    *,
    execution_name: str,
    now: int,
) -> dict:
    project = env.get("GCP_PROJECT_ID", "")
    region = env.get("GCP_REGION", "")
    instance_name = env.get("CLOUD_SQL_INSTANCE_NAME", "")
    network_name = env.get("MARKETING_NETWORK_NAME", "")
    subnet_name = env.get("MARKETING_SUBNETWORK_NAME", "")
    auth_name = env.get("MARKETING_AUTH_SERVICE_NAME", "")
    job_name = env.get("MARKETING_MIGRATION_JOB_NAME", "")
    release_sha = release.get("release_sha")
    require(
        env.get("ENVIRONMENT") == "preprod"
        and region == "asia-south1"
        and all(
            NAME.fullmatch(value or "")
            for value in (
                project,
                instance_name,
                network_name,
                subnet_name,
                auth_name,
                job_name,
            )
        )
        and SHA40.fullmatch(str(release_sha)) is not None
        and env.get("AXIOM_RELEASE_SHA") == release_sha
        and EXECUTION.fullmatch(execution_name) is not None,
        "Wrong adoption target, region or release",
    )
    instance = inventory["sql_instance"]
    require(
        isinstance(instance, dict)
        and exact_name(instance, instance_name)
        and instance.get("region") == region
        and instance.get("state") == "RUNNABLE"
        and instance.get("databaseVersion") == "POSTGRES_15"
        and instance.get("connectionName") == f"{project}:{region}:{instance_name}",
        "Cloud SQL identity or state differs",
    )
    ip_config = instance.get("settings", {}).get("ipConfiguration", {})
    require(
        ip_config.get("ipv4Enabled") is False
        and str(ip_config.get("privateNetwork", "")).endswith(
            "/networks/" + network_name
        ),
        "Cloud SQL is not isolated to private marketing network",
    )
    ips = instance.get("ipAddresses")
    require(
        isinstance(ips, list) and len(ips) == 1 and ips[0].get("type") == "PRIVATE",
        "Unexpected Cloud SQL address",
    )
    private_ip = ipaddress.ip_address(ips[0].get("ipAddress", ""))
    require(
        isinstance(private_ip, ipaddress.IPv4Address)
        and any(private_ip in network for network in RFC1918),
        "Cloud SQL address is not RFC1918 IPv4",
    )
    users = inventory["sql_users"]
    require(
        isinstance(users, list)
        and all(
            isinstance(user, dict) and isinstance(user.get("name"), str)
            for user in users
        )
        and {u["name"] for u in users}
        >= {"postgres", env.get("CLOUD_SQL_DATABASE_USER")}
        and {u["name"] for u in users}
        <= {
            "postgres",
            env.get("CLOUD_SQL_DATABASE_USER"),
            "supabase_auth_admin",
            "authenticator",
        },
        "Unexpected Cloud SQL users",
    )
    network = inventory["network"]
    subnet = inventory["subnet"]
    require(
        isinstance(network, dict)
        and exact_name(network, network_name)
        and network.get("autoCreateSubnetworks") is False
        and isinstance(subnet, dict)
        and exact_name(subnet, subnet_name)
        and str(subnet.get("network", "")).endswith("/networks/" + network_name)
        and subnet.get("region", "").endswith("/" + region),
        "Dedicated private network identity differs",
    )
    require(inventory["firewalls"] == [], "Marketing VPC has unreviewed firewall rules")
    validate_external_clients(
        inventory,
        network=network_name,
        subnet=subnet_name,
        auth=auth_name,
        job=job_name,
        region=region,
    )
    auth = inventory["auth_service"]
    require(
        isinstance(auth, dict)
        and exact_name(auth, auth_name)
        and auth.get("location", "")
        in {region, f"projects/{project}/locations/{region}"}
        and auth.get("ingress") == "INGRESS_TRAFFIC_ALL"
        and auth.get("invokerIamDisabled", False) is False,
        "GoTrue service identity or ingress differs",
    )
    auth_template = auth.get("template", {})
    auth_vpc = auth_template.get("vpcAccess", {})
    auth_interfaces = auth_vpc.get("networkInterfaces", [])
    auth_scaling = auth_template.get("scaling", {})
    auth_containers = auth_template.get("containers", [])
    require(
        auth_template.get("serviceAccount")
        == f"{env['MARKETING_AUTH_ACCOUNT_ID']}@{project}.iam.gserviceaccount.com"
        and auth_vpc.get("egress") == "PRIVATE_RANGES_ONLY"
        and isinstance(auth_interfaces, list)
        and len(auth_interfaces) == 1
        and same_network(auth_interfaces[0].get("network"), network_name)
        and str(auth_interfaces[0].get("subnetwork", "")).endswith(
            "/subnetworks/" + subnet_name
        )
        and auth_scaling.get("minInstanceCount") == 0
        and auth_scaling.get("maxInstanceCount") == 1
        and isinstance(auth_containers, list)
        and len(auth_containers) == 1
        and auth_containers[0].get("image") == release.get("images", {}).get("auth")
        and isinstance(auth.get("latestReadyRevision"), str)
        and bool(auth["latestReadyRevision"]),
        "GoTrue runtime is not bound to the reviewed private VPC and zero-idle scaling",
    )
    # Cloud Run IAM is authoritative for private invocation even when the
    # service's network ingress mode is ALL. No service/project invokers exist.
    auth_policy = inventory["auth_iam"]
    project_policy = inventory["project_iam"]
    project_bindings = (
        project_policy.get("bindings", []) if isinstance(project_policy, dict) else None
    )
    require(
        isinstance(auth_policy, dict)
        and auth_policy.get("bindings", []) == []
        and isinstance(project_bindings, list)
        and all(
            isinstance(binding, dict) and isinstance(binding.get("members", []), list)
            for binding in project_bindings
        )
        and not any(
            binding.get("role")
            in {
                "roles/run.invoker",
                "roles/secretmanager.secretAccessor",
                "roles/secretmanager.admin",
            }
            or any(
                member in {"allUsers", "allAuthenticatedUsers"}
                for member in binding.get("members", [])
            )
            for binding in project_bindings
        ),
        "Project-wide invocation or bootstrap secret access exists",
    )
    secret_policies = inventory["bootstrap_secret_iam"]
    migration_identity = (
        f"serviceAccount:{env['MARKETING_MIGRATION_ACCOUNT_ID']}"
        f"@{project}.iam.gserviceaccount.com"
    )
    expected_secrets = {
        env["MARKETING_ADMIN_DB_URL_SECRET"],
        env["MARKETING_AUTH_PASSWORD_SECRET"],
        env["MARKETING_REST_PASSWORD_SECRET"],
    }
    require(
        isinstance(secret_policies, dict) and set(secret_policies) == expected_secrets,
        "Bootstrap secret IAM inventory incomplete",
    )
    for policy in secret_policies.values():
        bindings = policy.get("bindings") if isinstance(policy, dict) else None
        require(
            isinstance(bindings, list)
            and bindings
            == [
                {
                    "role": "roles/secretmanager.secretAccessor",
                    "members": [migration_identity],
                }
            ],
            "Bootstrap secret has unexpected access",
        )
    job = inventory["job"]
    expected_image = release.get("auxiliary_images", {}).get("migrations")
    containers = job.get("template", {}).get("template", {}).get("containers", [])
    job_template = job.get("template", {}).get("template", {})
    require(
        isinstance(containers, list)
        and len(containers) == 1
        and containers[0].get("image") == expected_image
        and containers[0].get("args")
        == [
            "/app/scripts/marketing-db-job.py",
            "run-phase",
            "--phase",
            "inspect-clients",
        ]
        and job_template.get("serviceAccount")
        == migration_identity.removeprefix("serviceAccount:")
        and job_template.get("maxRetries") == 0
        and job.get("template", {}).get("taskCount") == 1,
        "Inspection Job does not use exact released migration image",
    )
    vpc = job_template.get("vpcAccess", {})
    interfaces = vpc.get("networkInterfaces", [])
    require(
        vpc.get("egress") == "PRIVATE_RANGES_ONLY"
        and isinstance(interfaces, list)
        and len(interfaces) == 1
        and str(interfaces[0].get("network", "")).endswith("/networks/" + network_name)
        and str(interfaces[0].get("subnetwork", "")).endswith(
            "/subnetworks/" + subnet_name
        ),
        "Inspection Job not bound to dedicated VPC",
    )
    executions = inventory["executions"]
    require(
        isinstance(executions, list)
        and executions
        and all(isinstance(item, dict) for item in executions),
        "Job execution inventory unavailable",
    )
    require(
        all(item.get("completionTime") for item in executions),
        "A migration Job is still active",
    )
    inspected = inventory["inspection_execution"]
    require(
        isinstance(inspected, dict)
        and exact_name(inspected, execution_name)
        and inspected.get("completionTime")
        and inspected.get("succeededCount") == 1
        and inspected.get("failedCount", 0) == 0
        and inspected.get("taskCount") == 1,
        "Inspection execution did not complete exactly once",
    )
    execution_containers = inspected.get("template", {}).get("containers", [])
    execution_template = inspected.get("template", {})
    require(
        isinstance(execution_containers, list)
        and len(execution_containers) == 1
        and execution_containers[0].get("image") == expected_image
        and execution_containers[0].get("args") == containers[0].get("args")
        and execution_template.get("serviceAccount")
        == job_template.get("serviceAccount")
        and execution_template.get("maxRetries") == 0
        and execution_template.get("vpcAccess") == vpc,
        "Inspection execution differs from reviewed released Job",
    )
    starts = timestamp(inspected.get("startTime"))
    finish = timestamp(inspected.get("completionTime"))
    require(
        now - finish <= MAX_LOG_AGE_SECONDS and finish <= now,
        "Inspection execution is stale",
    )
    facts = verify_inspection_log(
        inventory["inspection_logs"],
        project=project,
        region=region,
        job=job_name,
        execution=execution_name,
        release=release_sha,
        database=env["CLOUD_SQL_DATABASE_NAME"],
        start=starts,
        finish=finish,
        now=now,
    )
    login_roles = facts.get("login_roles")
    expected_logins = {
        "postgres",
        env["CLOUD_SQL_DATABASE_USER"],
        "supabase_auth_admin",
        "authenticator",
    }
    require(
        isinstance(login_roles, list)
        and len(login_roles) == len(expected_logins)
        and all(isinstance(role, dict) for role in login_roles)
        and {role.get("name") for role in login_roles} == expected_logins
        and {user["name"] for user in users} <= expected_logins,
        "Unknown PostgreSQL LOGIN role or Cloud SQL user",
    )
    limits = {role["name"]: role.get("connection_limit") for role in login_roles}
    require(
        limits.get("supabase_auth_admin") == 2
        and limits.get("authenticator") == 3
        and limits.get(env["CLOUD_SQL_DATABASE_USER"]) == 3
        and all(
            role.get("superuser") is False and role.get("bypassrls") is False
            for role in login_roles
            if role["name"] != "postgres"
        ),
        "PostgreSQL login privilege or connection limit differs",
    )
    metric_at = verify_zero_instance_metric(
        inventory["auth_instances"], service=auth_name, now=now
    )
    started = inventory.get("collected_start_unix")
    finished = inventory.get("collected_finish_unix")
    require(
        isinstance(started, int)
        and isinstance(finished, int)
        and 0 <= finished - started <= 180
        and 0 <= now - finished <= 10,
        "Adoption inventory was not collected in one fresh bounded window",
    )
    require(
        inventory["services_by_region"] == inventory["services_rescan_by_region"]
        and inventory["jobs_by_region"] == inventory["jobs_rescan_by_region"]
        and inventory["revisions_by_region"] == inventory["revisions_rescan_by_region"]
        and inventory["executions_by_region"]
        == inventory["executions_rescan_by_region"],
        "Cloud Run scope changed during adoption inventory",
    )
    # This eligibility is bounded to the observed, isolated bootstrap window.
    # The coordinator must re-collect immediately before the create-only seed;
    # the receipt is never an enduring permission or a database lock.
    return {
        "kind": "marketing-state-adoption-inventory",
        "release_sha": release_sha,
        "project": project,
        "connection_name": instance["connectionName"],
        "inspection_execution": execution_name,
        "inspection_facts_sha256": hashlib.sha256(
            json.dumps(facts, sort_keys=True).encode()
        ).hexdigest(),
        "observed_unix": now,
        "valid_until_unix": now + 30,
        "auth_zero_instance_observed_unix": metric_at,
        "exclusive_client_adoption": True,
        "no_other_clients": True,
        "seed_gate_enabled": True,
        "scope": "isolated preprod bootstrap; recheck immediately before create-only seed",
    }


def collect(env: dict[str, str], execution: str) -> dict:
    started = int(time.time())
    project = env["GCP_PROJECT_ID"]
    region = env["GCP_REGION"]
    instance = env["CLOUD_SQL_INSTANCE_NAME"]
    auth = env["MARKETING_AUTH_SERVICE_NAME"]
    job = env["MARKETING_MIGRATION_JOB_NAME"]
    network = env["MARKETING_NETWORK_NAME"]
    subnet = env["MARKETING_SUBNETWORK_NAME"]
    now = int(time.time())
    require(
        all(
            NAME.fullmatch(value)
            for value in (project, region, instance, auth, job, network, subnet)
        )
        and EXECUTION.fullmatch(execution) is not None,
        "Unsafe inventory target",
    )

    def get(*args: str) -> object:
        return cloud_get(list(args), project)

    run_regions = region_names(get("run", "regions", "list"))
    connector_regions = region_names(
        get("compute", "networks", "vpc-access", "locations", "list")
    )
    require(
        region in run_regions and region in connector_regions,
        "Target cloud region not fully inventoried",
    )
    services_by_region = {
        location: get("run", "services", "list", "--region", location)
        for location in run_regions
    }
    jobs_by_region = {
        location: get("run", "jobs", "list", "--region", location)
        for location in run_regions
    }
    revisions_by_region = {
        location: get("run", "revisions", "list", "--region", location)
        for location in run_regions
    }
    executions_by_region = {
        location: get("run", "jobs", "executions", "list", "--region", location)
        for location in run_regions
    }
    connectors_by_region = {
        location: get(
            "compute",
            "networks",
            "vpc-access",
            "connectors",
            "list",
            "--region",
            location,
        )
        for location in connector_regions
    }

    filter_text = (
        f'resource.type="cloud_run_job" AND resource.labels.project_id="{project}" '
        f'AND resource.labels.location="{region}" AND resource.labels.job_name="{job}" '
        f'AND labels.execution_name="{execution}" '
        f'AND logName="projects/{project}/logs/run.googleapis.com%2Fstdout"'
    )
    inventory = {
        "sql_instance": get("sql", "instances", "describe", instance),
        "sql_users": get("sql", "users", "list", "--instance", instance),
        "network": get("compute", "networks", "describe", network),
        "subnet": get(
            "compute", "networks", "subnets", "describe", subnet, "--region", region
        ),
        "firewalls": get(
            "compute", "firewall-rules", "list", "--filter", f"network:{network}"
        ),
        "peerings": get(
            "compute", "networks", "peerings", "list", "--network", network
        ),
        "routes": get("compute", "routes", "list", "--filter", f"network:{network}"),
        "compute_instances": get("compute", "instances", "list"),
        "gke_clusters": get("container", "clusters", "list"),
        "services_by_region": services_by_region,
        "jobs_by_region": jobs_by_region,
        "revisions_by_region": revisions_by_region,
        "executions_by_region": executions_by_region,
        "connectors_by_region": connectors_by_region,
        "auth_service": get("run", "services", "describe", auth, "--region", region),
        "auth_iam": get("run", "services", "get-iam-policy", auth, "--region", region),
        "project_iam": get("projects", "get-iam-policy", project),
        "bootstrap_secret_iam": {
            secret: get("secrets", "get-iam-policy", secret)
            for secret in (
                env["MARKETING_ADMIN_DB_URL_SECRET"],
                env["MARKETING_AUTH_PASSWORD_SECRET"],
                env["MARKETING_REST_PASSWORD_SECRET"],
            )
        },
        "job": get("run", "jobs", "describe", job, "--region", region),
        "executions": get(
            "run", "jobs", "executions", "list", "--job", job, "--region", region
        ),
        "inspection_execution": get(
            "run", "jobs", "executions", "describe", execution, "--region", region
        ),
        "inspection_logs": get(
            "logging", "read", filter_text, "--freshness=15m", "--limit=100"
        ),
        "auth_instances": monitoring_instances(project, auth, now),
    }
    inventory["services_rescan_by_region"] = {
        location: get("run", "services", "list", "--region", location)
        for location in run_regions
    }
    inventory["jobs_rescan_by_region"] = {
        location: get("run", "jobs", "list", "--region", location)
        for location in run_regions
    }
    inventory["revisions_rescan_by_region"] = {
        location: get("run", "revisions", "list", "--region", location)
        for location in run_regions
    }
    inventory["executions_rescan_by_region"] = {
        location: get("run", "jobs", "executions", "list", "--region", location)
        for location in run_regions
    }
    inventory["collected_start_unix"] = started
    inventory["collected_finish_unix"] = int(time.time())
    return inventory


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--inspection-execution", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        from importlib.util import module_from_spec, spec_from_file_location

        spec = spec_from_file_location(
            "marketing_preprod_config",
            Path(__file__).with_name("marketing-preprod-config.py"),
        )
        if spec is None or spec.loader is None:
            raise ValueError("Marketing config loader unavailable")
        config = module_from_spec(spec)
        spec.loader.exec_module(config)
        env = config.loader.parse(args.env_file)
        release = protected_json(args.release)
        inventory = collect(env, args.inspection_execution)
        result = validate(
            env,
            release,
            inventory,
            execution_name=args.inspection_execution,
            now=int(time.time()),
        )
        if args.output.exists() or args.output.is_symlink():
            raise ValueError("Adoption inventory output already exists")
        args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if (
            args.output.parent.is_symlink()
            or stat.S_IMODE(args.output.parent.stat().st_mode) & 0o077
        ):
            raise ValueError("Adoption output directory is not private")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(args.output, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as fd:
            json.dump(result, fd, sort_keys=True)
            fd.write("\n")
        print("Read-only adoption inventory recorded; lifecycle seed remains disabled.")
        return 0
    except (
        AttributeError,
        IndexError,
        KeyError,
        TypeError,
        ValueError,
        OSError,
        subprocess.TimeoutExpired,
    ):
        print(
            "Adoption inventory could not be verified; lifecycle seed remains disabled."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
