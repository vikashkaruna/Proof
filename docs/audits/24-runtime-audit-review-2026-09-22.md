# W4.3 runtime audit review — 22 September 2026

The identity foundation review found runtime defects that the green BFF/browser suite could not exercise. This slice closes the audit-specific findings before workload activation.

- Strict runtime environments could silently use memory after Supabase client-construction failure, or whenever configured with loopback. They now require the real append RPC. Explicit development/test loopback fixtures remain available; similarly named remote hosts cannot select memory.
- Missing append data became receipt `"0"`, allowing an unconfirmed append to appear successful. Positive PostgreSQL bigint receipts are now required. A real local PostgREST probe caught and corrected a draft assumption that these IDs were UUIDs.
- The base agent wrote raw input/output and exception/traceback detail to logs or immutable audit, potentially including approval material and personal data. It now records canonical payload digests plus fixed phase/receipt/failure-code metadata. Business output is returned only after mandatory completion evidence succeeds.
- Completion audit errors were swallowed and the invocation reported success. They now fail the invocation and withhold output. This is an audit failure, not evidence of rollback; already-performed side effects require reconciliation when an executor is implemented.
- Any Pydantic model instance bypassed the selected agent's input validation. Inputs and outputs are now validated against that agent's declared schemas.

Validation: 174 Python tests, including failure injection before execution and after work, error-audit failure, secret-bearing validation/provider errors, wrong model input, false/missing receipts, strict/local environment selection and lookalike hostnames. A real local Supabase/PostgREST harness verifies five durable-write/receipt/redaction/digest/chain outcomes and is included in CI. Only sanitized boolean artifacts are published. The local memory ledger is not claimed to reproduce PostgreSQL canonicalization or durability.

No historical ledger rows, SQL migrations, retention rules, approval rules or client systems are modified. Physical workload isolation, current task/grant checks, per-tool data scopes and verified token exchange remain pending W4.3/4. The broker's default denial and executor's 501 refusal remain intact. Review the exact staging CI result before closing this milestone.

Committed acceptance: source `956aa55` passed the real Postgres audit probe with all five outcomes and a clean source tree (`CI=true`, locked Python dependencies). Python unit tests passed 174/174; repository format checks and touched-file F/I lint passed. The merge CI result remains the final staging gate.
