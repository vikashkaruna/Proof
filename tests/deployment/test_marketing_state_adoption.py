"""Causal refusal tests for the read-only first-state adoption inventory."""

from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "marketing_state_adoption", ROOT / "scripts/marketing-state-adoption.py"
)
assert SPEC and SPEC.loader
adoption = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adoption)

PROJECT = "axiom-proof"
REGION = "asia-south1"
RELEASE = "a" * 40
IMAGE = "asia-south1-docker.pkg.dev/axiom-proof/images/migrations@sha256:" + "b" * 64
AUTH_IMAGE = "asia-south1-docker.pkg.dev/axiom-proof/images/auth@sha256:" + "c" * 64
NOW = 1_800_000_000
START = "2027-01-15T08:00:00Z"
FINISH = "2027-01-15T08:01:00Z"
INSPECTED = "axiom-proof-preprod-migrations-q1a2"
JOB = "axiom-proof-preprod-migrations"
NETWORK = "axiom-proof-preprod-marketing-network"
SUBNET = "axiom-proof-preprod-marketing-egress"
AUTH = "axiom-proof-preprod-auth"
INSTANCE = "axiom-proof-preprod-postgres"
SA = f"{JOB}@{PROJECT}.iam.gserviceaccount.com"


def env() -> dict[str, str]:
    return {
        "ENVIRONMENT": "preprod",
        "GCP_PROJECT_ID": PROJECT,
        "GCP_REGION": REGION,
        "AXIOM_RELEASE_SHA": RELEASE,
        "CLOUD_SQL_INSTANCE_NAME": INSTANCE,
        "CLOUD_SQL_DATABASE_NAME": "axiom_proof_preprod",
        "CLOUD_SQL_DATABASE_USER": "axiom_admin",
        "MARKETING_NETWORK_NAME": NETWORK,
        "MARKETING_SUBNETWORK_NAME": SUBNET,
        "MARKETING_AUTH_SERVICE_NAME": AUTH,
        "MARKETING_AUTH_ACCOUNT_ID": AUTH,
        "MARKETING_MIGRATION_JOB_NAME": JOB,
        "MARKETING_MIGRATION_ACCOUNT_ID": JOB,
        "MARKETING_ADMIN_DB_URL_SECRET": "axiom-proof-preprod-admin-db-url",
        "MARKETING_AUTH_PASSWORD_SECRET": "axiom-proof-preprod-auth-password",
        "MARKETING_REST_PASSWORD_SECRET": "axiom-proof-preprod-rest-password",
    }


def inventory() -> dict:
    import datetime

    # The synthetic wall clock matches the fixed execution timestamps.
    now = (
        int(datetime.datetime.fromisoformat(FINISH.replace("Z", "+00:00")).timestamp())
        + 30
    )
    assert now != NOW  # Tests pass the fixed execution-relative clock below.
    facts = {
        "database": "axiom_proof_preprod",
        "server_version_num": "150019",
        "encrypted_transport": True,
        "observer_role": "axiom_admin",
        "observer_superuser": False,
        "observer_can_read_all_stats": True,
        "observer_bypassrls": False,
        "login_roles": [
            {
                "name": "postgres",
                "connection_limit": -1,
                "superuser": False,
                "bypassrls": False,
            },
            {
                "name": "axiom_admin",
                "connection_limit": 3,
                "superuser": False,
                "bypassrls": False,
            },
            {
                "name": "supabase_auth_admin",
                "connection_limit": 2,
                "superuser": False,
                "bypassrls": False,
            },
            {
                "name": "authenticator",
                "connection_limit": 3,
                "superuser": False,
                "bypassrls": False,
            },
        ],
        "auth_migrations": 18,
        "application_migrations": 119,
        "clients": [],
    }
    secret_binding = {
        "bindings": [
            {
                "role": "roles/secretmanager.secretAccessor",
                "members": ["serviceAccount:" + SA],
            }
        ]
    }
    template = {
        "serviceAccount": SA,
        "maxRetries": 0,
        "containers": [
            {
                "image": IMAGE,
                "args": [
                    "/app/scripts/marketing-db-job.py",
                    "run-phase",
                    "--phase",
                    "inspect",
                ],
            }
        ],
        "vpcAccess": {
            "egress": "PRIVATE_RANGES_ONLY",
            "networkInterfaces": [
                {
                    "network": f"projects/{PROJECT}/global/networks/{NETWORK}",
                    "subnetwork": f"projects/{PROJECT}/regions/{REGION}/subnetworks/{SUBNET}",
                }
            ],
        },
    }
    return {
        "sql_instance": {
            "name": INSTANCE,
            "region": REGION,
            "state": "RUNNABLE",
            "databaseVersion": "POSTGRES_15",
            "connectionName": f"{PROJECT}:{REGION}:{INSTANCE}",
            "settings": {
                "ipConfiguration": {
                    "ipv4Enabled": False,
                    "privateNetwork": f"projects/{PROJECT}/global/networks/{NETWORK}",
                }
            },
            "ipAddresses": [{"type": "PRIVATE", "ipAddress": "10.65.0.2"}],
        },
        "sql_users": [{"name": "postgres"}, {"name": "axiom_admin"}],
        "network": {"name": NETWORK, "autoCreateSubnetworks": False},
        "subnet": {
            "name": SUBNET,
            "network": f"projects/{PROJECT}/global/networks/{NETWORK}",
            "region": f"https://www.googleapis.com/compute/v1/projects/{PROJECT}/regions/{REGION}",
        },
        "firewalls": [],
        "peerings": [{"name": "servicenetworking-googleapis-com", "state": "ACTIVE"}],
        "routes": [
            {
                "network": f"projects/{PROJECT}/global/networks/{NETWORK}",
                "nextHopGateway": f"projects/{PROJECT}/global/gateways/default-internet-gateway",
            }
        ],
        "compute_instances": [],
        "gke_clusters": [],
        "connectors_by_region": {REGION: []},
        "services_by_region": {REGION: [{"name": AUTH}]},
        "jobs_by_region": {REGION: [{"name": JOB}]},
        "revisions_by_region": {
            REGION: [
                {
                    "service": AUTH,
                    "vpcAccess": {"networkInterfaces": [{"network": NETWORK}]},
                }
            ]
        },
        "executions_by_region": {
            REGION: [{"name": INSPECTED, "completionTime": FINISH}]
        },
        "services_rescan_by_region": {REGION: [{"name": AUTH}]},
        "jobs_rescan_by_region": {REGION: [{"name": JOB}]},
        "revisions_rescan_by_region": {
            REGION: [
                {
                    "service": AUTH,
                    "vpcAccess": {"networkInterfaces": [{"network": NETWORK}]},
                }
            ]
        },
        "executions_rescan_by_region": {
            REGION: [{"name": INSPECTED, "completionTime": FINISH}]
        },
        "collected_start_unix": observation_time() - 20,
        "collected_finish_unix": observation_time() - 1,
        "auth_service": {
            "name": AUTH,
            "location": f"projects/{PROJECT}/locations/{REGION}",
            "ingress": "INGRESS_TRAFFIC_ALL",
            "latestReadyRevision": AUTH + "-00001",
            "template": {
                "serviceAccount": f"{AUTH}@{PROJECT}.iam.gserviceaccount.com",
                "containers": [{"image": AUTH_IMAGE}],
                "scaling": {"minInstanceCount": 0, "maxInstanceCount": 1},
                "vpcAccess": {
                    "egress": "PRIVATE_RANGES_ONLY",
                    "networkInterfaces": [
                        {
                            "network": f"projects/{PROJECT}/global/networks/{NETWORK}",
                            "subnetwork": f"projects/{PROJECT}/regions/{REGION}/subnetworks/{SUBNET}",
                        }
                    ],
                },
            },
        },
        "auth_iam": {"bindings": []},
        "project_iam": {"bindings": []},
        "bootstrap_secret_iam": {
            env()[key]: copy.deepcopy(secret_binding)
            for key in (
                "MARKETING_ADMIN_DB_URL_SECRET",
                "MARKETING_AUTH_PASSWORD_SECRET",
                "MARKETING_REST_PASSWORD_SECRET",
            )
        },
        "job": {"name": JOB, "template": {"taskCount": 1, "template": template}},
        "executions": [{"name": INSPECTED, "completionTime": FINISH}],
        "inspection_execution": {
            "name": INSPECTED,
            "startTime": START,
            "completionTime": FINISH,
            "succeededCount": 1,
            "failedCount": 0,
            "taskCount": 1,
            "template": copy.deepcopy(template),
        },
        "inspection_logs": [
            {
                "resource": {
                    "type": "cloud_run_job",
                    "labels": {
                        "project_id": PROJECT,
                        "location": REGION,
                        "job_name": JOB,
                    },
                },
                "labels": {"execution_name": INSPECTED},
                "logName": f"projects/{PROJECT}/logs/run.googleapis.com%2Fstdout",
                "timestamp": FINISH,
                "textPayload": __import__("json").dumps(
                    {
                        "kind": "marketing-database-client-inspection",
                        "release_sha": RELEASE,
                        "facts": facts,
                    }
                ),
            }
        ],
        "auth_instances": {
            "timeSeries": [
                {
                    "metric": {"type": "run.googleapis.com/container/instance_count"},
                    "resource": {
                        "type": "cloud_run_revision",
                        "labels": {"service_name": AUTH},
                    },
                    "points": [
                        {"interval": {"endTime": FINISH}, "value": {"int64Value": "0"}},
                        {"interval": {"endTime": START}, "value": {"int64Value": "0"}},
                    ],
                }
            ],
        },
    }


def observation_time() -> int:
    import datetime

    return (
        int(datetime.datetime.fromisoformat(FINISH.replace("Z", "+00:00")).timestamp())
        + 30
    )


class AdoptionTests(unittest.TestCase):
    def check(self, changed: dict | None = None) -> dict:
        data = inventory() if changed is None else changed
        return adoption.validate(
            env(),
            {
                "release_sha": RELEASE,
                "images": {"auth": AUTH_IMAGE},
                "auxiliary_images": {"migrations": IMAGE},
            },
            data,
            execution_name=INSPECTED,
            now=observation_time(),
        )

    def test_bounded_inventory_can_establish_short_lived_seed_eligibility(self) -> None:
        result = self.check()
        self.assertTrue(result["exclusive_client_adoption"])
        self.assertTrue(result["seed_gate_enabled"])
        self.assertEqual(result["valid_until_unix"], observation_time() + 30)
        self.assertEqual(result["inspection_execution"], INSPECTED)

    def test_released_inspection_job_is_accepted_by_adoption_and_runtime(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "marketing_db_job_contract", ROOT / "scripts/marketing-db-job.py"
        )
        assert spec and spec.loader
        job = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(job)
        source = {
            **env(),
            "MARKETING_MIGRATION_SERVICE_ACCOUNT": SA,
            "MARKETING_MIGRATION_IMAGE": IMAGE,
            "MARKETING_MIGRATION_CPU": "1",
            "MARKETING_MIGRATION_MEMORY": "256Mi",
            "MARKETING_MIGRATION_TIMEOUT_SECONDS": "60",
            "CLOUD_SQL_PRIVATE_IP": "10.65.0.2",
            "CLOUD_SQL_ADMIN_USER": "axiom_admin",
            "MARKETING_ADMIN_DB_URL_SECRET_ID": "axiom-proof-preprod-admin-db-url",
            "MARKETING_ADMIN_DB_URL_SECRET_VERSION": "1",
        }
        data = inventory()
        data["job"] = job.job_payload(source, "inspect")
        self.assertTrue(self.check(data)["exclusive_client_adoption"])
        args = data["job"]["template"]["template"]["containers"][0]["args"]
        phase = args[args.index("--phase") + 1]
        with (
            patch.object(job, "runtime_environment", return_value={}),
            patch.object(job, "inspect_clients") as inspect_clients,
            patch.object(job, "run_sql", side_effect=AssertionError("inspection mutated")),
        ):
            job.run_phase(source, phase)
        inspect_clients.assert_called_once_with(source, {})

    def test_public_sql_address_or_wrong_network_refused(self) -> None:
        for change in (
            lambda data: data["sql_instance"]["ipAddresses"].append(
                {"type": "PRIMARY", "ipAddress": "1.2.3.4"}
            ),
            lambda data: data["sql_instance"]["settings"]["ipConfiguration"].update(
                {"ipv4Enabled": True}
            ),
            lambda data: data["subnet"].update(
                {"network": "projects/other/global/networks/shared"}
            ),
            lambda data: data["firewalls"].append({"name": "unexpected-allow"}),
        ):
            data = inventory()
            change(data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(data)

    def test_new_invoker_or_client_path_refused(self) -> None:
        for change in (
            lambda data: data["auth_iam"].update(
                {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
            ),
            lambda data: data["project_iam"].update(
                {
                    "bindings": [
                        {
                            "role": "roles/run.invoker",
                            "members": ["allAuthenticatedUsers"],
                        }
                    ]
                }
            ),
            lambda data: data["project_iam"].update(
                {
                    "bindings": [
                        {
                            "role": "roles/secretmanager.secretAccessor",
                            "members": ["serviceAccount:foreign@example.invalid"],
                        }
                    ]
                }
            ),
            lambda data: data["services_by_region"][REGION].append(
                {
                    "name": "axiom-proof-preprod-bff",
                    "template": {
                        "vpcAccess": {"networkInterfaces": [{"network": NETWORK}]}
                    },
                }
            ),
            lambda data: data["bootstrap_secret_iam"][
                env()["MARKETING_ADMIN_DB_URL_SECRET"]
            ]["bindings"][0]["members"].append("allUsers"),
            lambda data: data["executions"].append({"name": "active"}),
        ):
            data = inventory()
            change(data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(data)

    def test_inspection_must_be_exact_execution_and_complete_observer(self) -> None:
        for change in (
            lambda data: data["job"]["template"]["template"]["containers"][0].update(
                {"image": "foreign"}
            ),
            lambda data: data["inspection_execution"].update({"succeededCount": 0}),
            lambda data: data["inspection_logs"][0]["labels"].update(
                {"execution_name": "other"}
            ),
            lambda data: data["inspection_logs"][0].update({"timestamp": START}),
            lambda data: data["inspection_logs"].append(
                copy.deepcopy(data["inspection_logs"][0])
            ),
            lambda data: data["inspection_logs"][0].update(
                {
                    "textPayload": '{"kind":"marketing-database-client-inspection","release_sha":"foreign"}'
                }
            ),
        ):
            data = inventory()
            change(data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(data)

    def test_live_clients_or_blind_inspector_refused(self) -> None:
        for fact, value in (
            ("clients", [{"role": "supabase_auth_admin", "state": "idle"}]),
            ("observer_can_read_all_stats", False),
            ("encrypted_transport", False),
            ("application_migrations", 118),
            (
                "login_roles",
                [
                    {
                        "name": "unreviewed_login",
                        "connection_limit": -1,
                        "superuser": False,
                        "bypassrls": False,
                    }
                ],
            ),
        ):
            data = inventory()
            message = __import__("json").loads(
                data["inspection_logs"][0]["textPayload"]
            )
            message["facts"][fact] = value
            data["inspection_logs"][0]["textPayload"] = __import__("json").dumps(
                message
            )
            with self.subTest(fact=fact), self.assertRaises(ValueError):
                self.check(data)

    def test_missing_or_nonzero_monitoring_point_refused(self) -> None:
        for points in (
            [],
            [
                {"interval": {"endTime": FINISH}, "value": {"int64Value": "1"}},
                {"interval": {"endTime": START}, "value": {"int64Value": "0"}},
            ],
        ):
            data = inventory()
            data["auth_instances"]["timeSeries"][0]["points"] = points
            with self.subTest(points=points), self.assertRaises(ValueError):
                self.check(data)

    def test_stale_or_changed_scope_refused(self) -> None:
        for change in (
            lambda data: data.update(
                {"collected_start_unix": observation_time() - 300}
            ),
            lambda data: data.update(
                {"collected_finish_unix": observation_time() - 15}
            ),
            lambda data: data["services_rescan_by_region"][REGION].append(
                {"name": "new-service"}
            ),
            lambda data: data["jobs_rescan_by_region"][REGION].append(
                {"name": "new-job"}
            ),
            lambda data: data["revisions_rescan_by_region"][REGION].append(
                {"service": "new-service"}
            ),
            lambda data: data["executions_rescan_by_region"][REGION].append(
                {"name": "new-execution"}
            ),
        ):
            data = inventory()
            change(data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(data)

    def test_foreign_vpc_clients_and_routes_refused(self) -> None:
        for change in (
            lambda data: data["compute_instances"].append(
                {"networkInterfaces": [{"network": NETWORK}]}
            ),
            lambda data: data["gke_clusters"].append({"network": NETWORK}),
            lambda data: data["connectors_by_region"][REGION].append(
                {"network": NETWORK}
            ),
            lambda data: data["routes"].append(
                {"network": NETWORK, "nextHopVpnTunnel": "foreign"}
            ),
            lambda data: data["peerings"].append(
                {"name": "foreign", "state": "ACTIVE"}
            ),
            lambda data: data["jobs_by_region"][REGION].append(
                {
                    "name": "foreign",
                    "template": {
                        "template": {
                            "vpcAccess": {"networkInterfaces": [{"network": NETWORK}]}
                        }
                    },
                }
            ),
            lambda data: data["revisions_by_region"][REGION].append(
                {
                    "service": "foreign",
                    "vpcAccess": {"networkInterfaces": [{"network": NETWORK}]},
                }
            ),
            lambda data: data["executions_by_region"][REGION].append(
                {"name": "running-job"}
            ),
            lambda data: (
                data["services_by_region"].update(
                    {
                        "us-central1": [
                            {
                                "name": "foreign",
                                "template": {
                                    "vpcAccess": {
                                        "networkInterfaces": [{"network": NETWORK}]
                                    }
                                },
                            }
                        ]
                    }
                ),
                data["jobs_by_region"].update({"us-central1": []}),
                data["revisions_by_region"].update({"us-central1": []}),
                data["executions_by_region"].update({"us-central1": []}),
            ),
        ):
            data = inventory()
            change(data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(data)

    def test_collector_uses_only_explicit_read_only_project_scoped_commands(
        self,
    ) -> None:
        calls: list[tuple[list[str], str]] = []

        def fake(args: list[str], project: str) -> object:
            calls.append((args, project))
            if args[:3] == ["run", "regions", "list"]:
                return [{"name": REGION}, {"name": "us-central1"}]
            if args[:6] == ["compute", "networks", "vpc-access", "locations", "list"]:
                return [{"name": REGION}, {"name": "us-central1"}]
            return {}

        with (
            patch.object(adoption, "cloud_get", fake),
            patch.object(adoption, "monitoring_instances", return_value={}),
        ):
            adoption.collect(env(), INSPECTED)
        self.assertEqual(len(calls), 39)
        self.assertTrue(all(project == PROJECT for _, project in calls))
        self.assertTrue(
            any(
                args[:3] == ["run", "services", "list"] and args[-1] == "us-central1"
                for args, _ in calls
            )
        )
        self.assertTrue(
            any(
                args[:2] == ["logging", "read"]
                and f'labels.execution_name="{INSPECTED}"' in args[2]
                for args, _ in calls
            )
        )
        self.assertFalse(
            any(
                token in {"create", "update", "delete", "execute", "apply"}
                for args, _ in calls
                for token in args
            )
        )


if __name__ == "__main__":
    unittest.main()
