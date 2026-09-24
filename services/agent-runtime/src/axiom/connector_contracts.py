"""W4.1 transport interfaces. Context is not authority; W4 broker checks are mandatory.

WriteConnector intentionally does not inherit ReadConnector. No adapter here executes
SQL, accepts credentials, or grants Sudhaar direct access to a client system.
"""

from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict


class ConnectorInvocation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    tenant_id: str
    estate_id: str
    system_id: str
    connector_id: str
    descriptor_sha256: str
    grant_id: str
    workload_identity: str
    correlation_id: str
    deadline: str


class WriteInvocation(ConnectorInvocation):
    approval_token: str
    action_id: str
    batch_id: str
    target_binding: Literal["production"]


class ConnectorResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    records: list[dict[str, object]]
    cursor: str | None = None


class WriteReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    receipt_id: str


class ReadConnector(Protocol):
    async def enumerate(self, context: ConnectorInvocation) -> ConnectorResult: ...
    async def sample(
        self, context: ConnectorInvocation, resource: str, limit: int
    ) -> ConnectorResult: ...
    async def read(
        self, context: ConnectorInvocation, resource: str, cursor: str | None = None
    ) -> ConnectorResult: ...


class WriteConnector(Protocol):
    async def execute(
        self, context: WriteInvocation, operation: str, parameters: dict[str, object]
    ) -> WriteReceipt: ...
