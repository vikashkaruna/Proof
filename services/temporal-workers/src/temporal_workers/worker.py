"""Temporal worker entry point.

The worker registers the workflow and activity implementations
with the Temporal cluster (Cloud, ap-south-1). Multiple workers can
be deployed for HA; Temporal handles distribution.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
from pathlib import Path
from typing import Any

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import call_agent_runtime
from .assessment_activity import AssessmentControllerActivity
from .assessment_jobs import TASK_QUEUE as ASSESSMENT_QUEUE
from .assessment_jobs import AssessmentJobWorkflow
from .assessment_outbox import AssessmentOutboxPump
from .assessment_remote import RemoteAssessmentControllerActivity
from .workflows import TASK_QUEUE, ComplianceEngagementWorkflow

log = logging.getLogger(__name__)


async def handle_health(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    try:
        await reader.read(1024)
        body = b'{"status":"ok","service":"temporal-worker"}\n'
        response = (
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
            b"Connection: close\r\n\r\n" + body
        )
        writer.write(response)
        await writer.drain()
    except (OSError, ConnectionError):
        # A probe that disconnects early needs no response.
        log.debug("temporal_worker.health_probe_disconnected")
    finally:
        with contextlib.suppress(OSError, ConnectionError):
            writer.close()
            await writer.wait_closed()


def _is_temporal_cloud(address: str) -> bool:
    """Match the Temporal Cloud host exactly; the address is ``host:port``."""
    host = address.split("://")[-1].split("/")[0].rsplit(":", 1)[0].lower()
    return any(
        host == domain or host.endswith("." + domain)
        for domain in ("tmprl.cloud", "temporal.io")
    )


def build_workers(
    client: Client,
    controller: AssessmentControllerActivity
    | RemoteAssessmentControllerActivity
    | None = None,
):
    # Explicit private mode is a separate worker process/queue. It must not
    # also poll legacy workflows carrying raw interview/assessment payloads.
    if controller is not None:
        return [
            Worker(
                client,
                task_queue=ASSESSMENT_QUEUE,
                workflows=[AssessmentJobWorkflow],
                activities=[controller.invoke],
            )
        ]
    return [
        Worker(
            client,
            task_queue=TASK_QUEUE,
            workflows=[ComplianceEngagementWorkflow],
            activities=[call_agent_runtime],
        )
    ]


async def run_worker_loop(
    address: str,
    namespace: str,
    api_key: str | None,
    tls_config: Any,
    controller: AssessmentControllerActivity
    | RemoteAssessmentControllerActivity
    | None = None,
    outbox_pump: bool = False,
) -> None:
    if outbox_pump and controller is None:
        raise ValueError("Outbox pickup requires private controller configuration")
    backoff = 2
    while True:
        try:
            log.info("temporal_worker.connecting")
            client = await Client.connect(
                address,
                namespace=namespace,
                api_key=api_key if api_key else None,
                tls=tls_config,
            )
            log.info("temporal_worker.connected")
            workers = build_workers(client, controller)
            backoff = 2
            tasks = [asyncio.create_task(worker.run()) for worker in workers]
            if outbox_pump:
                tasks.append(
                    asyncio.create_task(AssessmentOutboxPump(client, controller).run())
                )
            try:
                await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            log.info("temporal_worker.cancelled")
            break
        except Exception:  # noqa: BLE001 — never log transport credentials or failures.
            log.warning("temporal_worker.connection_failed; retrying in %ss", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


def assessment_options(argv: list[str] | None = None):
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--assessment-controller-socket")
    mode.add_argument("--assessment-controller-origin")
    parser.add_argument("--assessment-controller-uid", type=int)
    parser.add_argument("--assessment-outbox-pump", action="store_true")
    args = parser.parse_args(argv)
    if args.assessment_outbox_pump and not (
        args.assessment_controller_socket or args.assessment_controller_origin
    ):
        parser.error("Outbox pickup requires private controller configuration")
    if bool(args.assessment_controller_socket) != (
        args.assessment_controller_uid is not None
    ):
        parser.error(
            "Private controller socket and owner UID must be configured together"
        )
    controller = (
        RemoteAssessmentControllerActivity(args.assessment_controller_origin)
        if args.assessment_controller_origin
        else AssessmentControllerActivity(
            args.assessment_controller_socket, args.assessment_controller_uid
        )
        if args.assessment_controller_socket
        else None
    )
    return controller, args.assessment_outbox_pump


async def main():
    controller, outbox_pump = assessment_options()
    logging.basicConfig(level=logging.INFO)
    port = int(os.environ.get("PORT", "8080"))
    # Container health listener; exposure is controlled by the platform.
    server = await asyncio.start_server(handle_health, "0.0.0.0", port)  # nosec B104
    log.info(f"temporal_worker.health_server_listening port={port}")

    address = os.environ.get("TEMPORAL_ADDRESS", "ap-south-1.aws.api.temporal.io:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "axiom-proof")
    api_key = os.environ.get("TEMPORAL_API_KEY")
    tls_enabled = os.environ.get("TEMPORAL_TLS", "true").lower() == "true"
    client_cert = os.environ.get("TEMPORAL_CLIENT_CERT")
    client_key = os.environ.get("TEMPORAL_CLIENT_KEY")
    cert_path = os.environ.get("TEMPORAL_CERT_PATH")
    key_path = os.environ.get("TEMPORAL_KEY_PATH")

    tls_config: bool | Any = tls_enabled
    if client_cert and client_key:
        from temporalio.service import TLSConfig

        tls_config = TLSConfig(
            client_cert=client_cert.encode("utf-8")
            if isinstance(client_cert, str)
            else client_cert,
            client_private_key=client_key.encode("utf-8")
            if isinstance(client_key, str)
            else client_key,
        )
    elif (
        cert_path
        and key_path
        and os.path.exists(cert_path)
        and os.path.exists(key_path)
    ):
        from temporalio.service import TLSConfig

        cert_bytes = await asyncio.to_thread(Path(cert_path).read_bytes)
        key_bytes = await asyncio.to_thread(Path(key_path).read_bytes)
        tls_config = TLSConfig(client_cert=cert_bytes, client_private_key=key_bytes)

    if (
        not api_key
        and not client_cert
        and not cert_path
        and _is_temporal_cloud(address)
    ):
        log.warning(
            "No TEMPORAL_API_KEY or mTLS certs provided; proceeding with TLS enabled."
        )

    worker_task = asyncio.create_task(
        run_worker_loop(
            address,
            namespace,
            api_key,
            tls_config,
            controller,
            outbox_pump,
        )
    )

    async with server:
        await asyncio.gather(server.serve_forever(), worker_task)


if __name__ == "__main__":
    asyncio.run(main())
