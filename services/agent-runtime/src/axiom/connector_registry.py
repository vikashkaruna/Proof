"""Strict non-secret descriptor loader. This registry never constructs an executor."""

import re
from typing import Annotated, ClassVar, Literal
from uuid import UUID

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from yaml.events import AliasEvent, NodeEvent
from yaml.nodes import MappingNode, Node, SequenceNode

Identifier = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]{0,79}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ReadOperation(StrictModel):
    operation: Identifier
    mutating: Literal[False]

    @field_validator("mutating", mode="before")
    @classmethod
    def exact_boolean(cls, value: object) -> object:
        if type(value) is not bool:
            raise ValueError("A boolean is required")
        return value


class WriteOperation(StrictModel):
    operation: Identifier
    mutating: Literal[True]
    requiresApprovalToken: Literal[True]  # noqa: N815

    @field_validator("mutating", "requiresApprovalToken", mode="before")
    @classmethod
    def exact_boolean(cls, value: object) -> object:
        if type(value) is not bool:
            raise ValueError("A boolean is required")
        return value


class Capabilities(StrictModel):
    enumerate: ReadOperation
    sample: ReadOperation | None = None
    read: ReadOperation | None = None
    write: WriteOperation | None = None


class RateLimit(StrictModel):
    requestsPerSecond: Annotated[int, Field(ge=1, le=1000)]  # noqa: N815
    burst: Annotated[int, Field(ge=1, le=1000)]


class ConnectorManifest(StrictModel):
    schemaVersion: Literal[1]  # noqa: N815
    id: str
    target: Annotated[str, Field(pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$", max_length=80)]
    version: Annotated[
        str, Field(pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$", max_length=40)
    ]
    transport: Literal["rest", "sql", "graphql", "mcp"]
    targetBinding: Literal["production", "sandbox", "reference-mock"]  # noqa: N815
    auth: Literal[
        "oauth2.client_credentials",
        "oauth2.jwt_bearer",
        "oauth2.token_exchange",
        "oauth2.saml2_bearer",
        "cloud_iam",
        "legacy_static",
    ]
    assurance: Literal["high", "low"]
    capabilities: Capabilities
    dataCategoryHints: Annotated[list[Identifier], Field(max_length=40)]  # noqa: N815
    rateLimit: RateLimit  # noqa: N815

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def exact_integer(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("An integer is required")
        return value

    @model_validator(mode="after")
    def validate_policy(self) -> "ConnectorManifest":
        identifier = UUID(self.id)
        if identifier.version not in range(1, 9) or str(identifier) != self.id.lower():
            raise ValueError("Invalid descriptor id")
        if self.targetBinding != "production" and self.capabilities.write is not None:
            raise ValueError("Non-production bindings cannot declare writes")
        if (self.auth == "legacy_static") != (self.assurance == "low"):
            raise ValueError("Credential family does not match assurance")
        # Optional fields must be absent rather than explicit null, matching Zod.
        if any(
            getattr(self.capabilities, key) is None for key in self.capabilities.model_fields_set
        ):
            raise ValueError("Null capabilities are forbidden")
        return self


class DescriptorLoader(yaml.SafeLoader):
    """Use YAML 1.2 booleans; never coerce a target named on/off or a timestamp."""

    yaml_implicit_resolvers: ClassVar[dict[str | None, list[tuple[str, re.Pattern[str]]]]] = {
        key: [
            (tag, regex)
            for tag, regex in values
            if tag not in ("tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp")
        ]
        for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }


DescriptorLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool", re.compile(r"^(?:true|false|True|False|TRUE|FALSE)$"), list("tTfF")
)


def _check_tree(node: Node, depth: int = 0) -> None:
    if depth > 12:
        raise ValueError("Descriptor nesting exceeds limit")
    if node.tag in ("tag:yaml.org,2002:int", "tag:yaml.org,2002:float") and not re.fullmatch(
        r"0|[1-9][0-9]*", node.value
    ):
        raise ValueError("Descriptor numbers must be unsigned decimal integers")
    if isinstance(node, MappingNode):
        seen: set[str] = set()
        for key, value in node.value:
            if key.tag != "tag:yaml.org,2002:str" or key.value in seen:
                raise ValueError("Duplicate or non-string YAML key")
            seen.add(key.value)
            _check_tree(value, depth + 1)
    elif isinstance(node, SequenceNode):
        for item in node.value:
            _check_tree(item, depth + 1)


def load_descriptor(source: str) -> ConnectorManifest:
    if len(source.encode("utf-8")) > 65536:
        raise ValueError("Descriptor exceeds 64 KiB")
    for event in yaml.parse(source):
        if isinstance(event, AliasEvent) or (
            isinstance(event, NodeEvent) and (event.anchor or getattr(event, "tag", None))
        ):
            raise ValueError("YAML aliases, anchors and tags are forbidden")
    root = yaml.compose(source, Loader=DescriptorLoader)
    if root is None:
        raise ValueError("Empty descriptor")
    _check_tree(root)
    return ConnectorManifest.model_validate(yaml.load(source, Loader=DescriptorLoader))


def build_registry(sources: list[str]) -> dict[str, ConnectorManifest]:
    result: dict[str, ConnectorManifest] = {}
    versions: set[tuple[str, str, str]] = set()
    for source in sources:
        manifest = load_descriptor(source)
        key = (manifest.target, manifest.version, manifest.targetBinding)
        if manifest.id in result or key in versions:
            raise ValueError("Duplicate descriptor identity/version")
        result[manifest.id] = manifest
        versions.add(key)
    return result
