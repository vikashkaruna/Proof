"""Temporal worker entry point.

The worker registers the workflow and activity implementations
with the Temporal cluster (Cloud, ap-south-1). Multiple workers can
be deployed for HA; Temporal handles distribution.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import call_agent_runtime
from .workflows import TASK_QUEUE, ComplianceEngagementWorkflow


async def handle_health(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
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
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def run_worker_loop(
    address: str,
    namespace: str,
    api_key: str | None,
    tls_config: Any,
) -> None:
    backoff = 2
    while True:
        try:
            logging.info(f"temporal_worker.connecting address={address} namespace={namespace}")
            client = await Client.connect(
                address,
                namespace=namespace,
                api_key=api_key if api_key else None,
                tls=tls_config,
            )
            logging.info(f"temporal_worker.connected address={address} namespace={namespace}")
            worker = Worker(
                client,
                task_queue=TASK_QUEUE,
                workflows=[ComplianceEngagementWorkflow],
                activities=[call_agent_runtime],
            )
            backoff = 2
            await worker.run()
        except asyncio.CancelledError:
            logging.info("temporal_worker.cancelled")
            break
        except Exception as e:
            logging.warning(
                f"temporal_worker.connection_failed: {e}. Retrying in {backoff}s..."
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


async def main():
    logging.basicConfig(level=logging.INFO)
    port = int(os.environ.get("PORT", "8080"))
    server = await asyncio.start_server(handle_health, "0.0.0.0", port)
    logging.info(f"temporal_worker.health_server_listening port={port}")

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
            client_cert=client_cert.encode("utf-8") if isinstance(client_cert, str) else client_cert,
            client_private_key=client_key.encode("utf-8") if isinstance(client_key, str) else client_key,
        )
    elif cert_path and key_path and os.path.exists(cert_path) and os.path.exists(key_path):
        from temporalio.service import TLSConfig
        with open(cert_path, "rb") as f:
            cert_bytes = f.read()
        with open(key_path, "rb") as f:
            key_bytes = f.read()
        tls_config = TLSConfig(client_cert=cert_bytes, client_private_key=key_bytes)

    if not api_key and not client_cert and not cert_path and ("temporal.io" in address or "tmprl.cloud" in address):
        logging.warning("No TEMPORAL_API_KEY or mTLS certs provided; proceeding with TLS enabled.")

    worker_task = asyncio.create_task(
        run_worker_loop(address, namespace, api_key, tls_config)
    )

    async with server:
        await asyncio.gather(server.serve_forever(), worker_task)


if __name__ == "__main__":
    asyncio.run(main())
