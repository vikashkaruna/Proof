# Revision 83 — W4.5 internal tool registry

## Scope and assumptions

Doc 11 defines W4.5 as the perimeter-scoped internal tool registry, with hash-pinned descriptions and deny-by-default read/write classification. It also sets three safety rules: classification is mandatory, and an unclassified tool is refused; tool output is data, and descriptions are re-verified each session; Karya's parameters come only from the approved plan. Operator input was not received. The assumptions are:

1. Registration belongs to connector managers (owners, admins, founders). It is audited and append-only. A new version is a new row, and an existing version cannot be redefined.
2. Write tools are refused on reference and sandbox bindings, the same rule as write grants.
3. Registering a tool authorizes nothing. `ToolRegistry.verify` accepts a tool only when all of these hold:
   - it is registered for that connector;
   - the connector is active;
   - the description observed this session hashes to the value pinned at registration (sha256, computed by the database);
   - the class in the registry matches the lease scope: read tools need a read lease, write tools a write lease.

   The class comes from the registry, never from the tool's own metadata.

4. Binding Karya's parameters to the approved plan is enforced at the approval token (W5) and is not changed here.

## Change

- **Migration 0057:** ledger action `connector.tool.registered`, plus two functions, `register_connector_tool` and `verify_connector_tool`, which only the backend can call.
- **`services/bff/src/connectors/tool-registry.ts`:** `ToolRegistry`, with a `ToolRefused` error on any mismatch.
- **BFF routes:** `GET /v1/connectors/:id/tools` (posture read) and `POST /v1/connectors/:id/tools` (connector management, strict body with a mandatory `operationClass`).

## Verification

| Check                                                                                                                                                                                                                                                                                                                    | Result                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `internal-tool-registry.test.sql`. It covers: role; missing or unknown classification; name and schema validation; no write on sandbox; database hash pin; audit; no redefinition; new version; changed or unregistered description refused; the backend cannot reclassify; tools on a disabled connector do not verify. | pass. A deliberately broken assertion fails, confirming the assertions execute. |
| `tool-registry.test.ts` (4) and registration route test (1)                                                                                                                                                                                                                                                              | pass                                                                            |

## Limits

- There is no UI for registration yet; it is an API only.
- No agent invokes tools through the registry yet. That wiring comes with the first live binding (W4.6).
