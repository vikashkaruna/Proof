# Axiom Proof — Operational Runbook

This is the day-2 operations document. For initial setup, see
[`08_DEPLOYMENT_GUIDE.md`](./08_DEPLOYMENT_GUIDE.md). For the security
posture, see [`07_SECURITY_REVIEW.md`](./07_SECURITY_REVIEW.md).

## Daily

- [ ] Check the audit ledger `verify_ledger()` returns 0 rows for
      each active tenant.
- [ ] Review the previous day's failed agent runs (status = "failed"
      in `agent_runs`).
- [ ] Review the previous day's execution failures (status =
      "failure" in `audit_ledger`).
- [ ] Confirm the kill switch status is `engaged: false`.

## Weekly

- [ ] Review the gap-scan conversion rate
      (`gap_scan_responses` with `follow_up_requested: true`).
- [ ] Review the average time from gap-scan to first paid engagement.
- [ ] Rotate the approval signing key if any user with the role
      `founder` has had their session compromised.

## Monthly

- [ ] Run `pnpm audit` and `pip-audit` in CI and review the
      high/critical findings.
- [ ] Review the Model Gateway's per-tenant cost attribution
      (NFR-11: should stay < 15% of client ACV).
- [ ] Backup verification: confirm PITR on Supabase, cross-region
      S3 replication status, Terraform state integrity.

## Quarterly

- [ ] Disaster recovery exercise: rebuild a non-prod environment
      from scratch using this guide.
- [ ] Penetration test (Phase 3+).
- [ ] Before enabling production Karya execution, complete the external
      Phase 3 TODOs: mTLS, MFA assurance enforcement, AWS Object Lock,
      Supabase privilege checks, and residency evidence.
- [ ] SOC 2 / ISO 27001 audit prep (Phase 5+).

---

## Common procedures

### Engage the kill switch

```bash
# Via the UI
# Open any plan in the Approval Console → "Engage kill switch"
# Confirm. The action is recorded in the audit ledger.

# Or via the BFF API
curl -X POST https://app.axiomproof.ai/api/bff/v1/kill-switch/engage \
  -H "Authorization: Bearer $FOUNDER_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"scope": "global", "reason": "describe what triggered this"}'
```

### Release the kill switch

The kill switch can only be released by a user with the `founder` or
`owner` role:

```bash
curl -X POST https://app.axiomproof.ai/api/bff/v1/kill-switch/release \
  -H "Authorization: Bearer $FOUNDER_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID"
```

### Investigate a failing agent run

1. Get the correlation_id from the agent run record (e.g. from the
   workbench, or directly from the `agent_runs` table).
2. Reconstruct the full chain:
   ```sql
   SELECT sequence_no, actor_type, actor_id, action_type, result, occurred_at, detail
   FROM audit_ledger
   WHERE correlation_id = '<correlation-uuid>'
   ORDER BY sequence_no;
   ```
3. Look for the `error` field in the `detail` JSON.
4. If the error is in a third-party call (Bedrock, Temporal), check
   the upstream service's status page.
5. If the error is in the agent runtime itself, check the pod logs:
   ```bash
   kubectl -n axiom-proof logs -l app.kubernetes.io/component=agent-runtime --tail=500
   ```

### Rotate the approval signing key

```bash
NEW_KEY=$(openssl rand -hex 32)
CURRENT=$(aws secretsmanager get-secret-value --secret-id axiom-proof/internal --region ap-south-1 --query SecretString --output text)

# Use jq to update the approval-key field
echo "$CURRENT" | jq --arg k "$NEW_KEY" '.["approval-key"] = $k' \
  | aws secretsmanager put-secret-value \
    --secret-id axiom-proof/internal \
    --secret-string "$(cat)" \
    --region ap-south-1

# Roll the BFF to pick up the new key
kubectl -n axiom-proof rollout restart deployment/axiom-proof-bff

# All previously-issued approval tokens are now invalid. Any in-flight
# execution that has a stale token will be rejected by the BFF.
```

### Rotate the MFA encryption key

Unlike the approval signing key, this one cannot simply be replaced: a TOTP
secret has to be recoverable to check a code, so every enrolled factor is
sealed under it. Replacing it on its own does not invalidate tokens, it locks
out every enrolled user at once.

The BFF reads a **ring**. `AXIOM_MFA_ENCRYPTION_KEY` seals new and rewrapped
secrets; `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` is a comma-separated list,
newest first, of keys that may still be read. Each stored secret names the key
that sealed it, so both can be live at once.

```bash
# 1. Mint a new primary and carry the outgoing key onto the retiring list.
#    MINT_FORCE is required: rotating a live secret is a deliberate act.
MINT_FORCE=true ./scripts/sync-env.sh <env> mint

# 2. Confirm the ring before deploying anything.
#    `verify` prints how many retiring keys are still in play.
./scripts/sync-env.sh <env> verify
```

Then roll the BFF. Enrolled factors keep working throughout: each one is
rewritten under the new key the next time its owner verifies, so the rotation
drains at the pace people log in rather than in a single pass that would
decrypt every TOTP secret into one process.

**How the retiring list reaches a deployed BFF.** Until Revision 18 it did
not: Compose carried it, Cloud Run and Helm carried only the primary key, so
step 2 could pass and the rolled service would still have half a ring. Both
surfaces express "no rotation in flight" as _absent_ rather than empty,
because an empty value is not storable as a Secret Manager version and is not
a key.

| Surface                                 | Retiring list                                                                                                                    | Clearing it                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Compose (local, staging, preprod, prod) | `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS`, empty by default                                                                           | Unset the variable                          |
| Cloud Run (preprod)                     | `mfa_encryption_keys_previous` in `.env` → tfvars → a Secret Manager secret that exists **only** while the variable is non-empty | Clear it and apply; the secret is destroyed |
| Helm (prod/EKS)                         | Key `mfa-encryption-keys-previous` in the `<release>-internal` Secret, read with `optional: true`                                | Remove the key; pods start without it       |

`scripts/check-mfa-ring-coverage.sh` fails the build if a surface that runs the
BFF cannot carry both halves. A surface added later belongs in that list.

**Do not remove a key from the retiring list until nothing is sealed under
it.** Removing it early is the lockout this design exists to prevent. If it
happens, affected users get `secret_unreadable` and HTTP 503 — a deliberate,
distinct signal rather than a rejected code — and the fix is to put the key
back on the list. Users who cannot wait can authenticate with a recovery code.

There is no query that reports the remaining count directly: the key id in
each envelope is a hash, so compare it against the primary key's id if you
need to measure how far a rotation has drained.

### Verify the audit ledger

```sql
-- Per-tenant integrity check
SELECT * FROM verify_ledger('<tenant-uuid>');
-- 0 rows = chain intact.
-- 1+ rows = the first break, with reason.
```

### Replay an agent run

The audit ledger captures every action; the agent runtime is
stateless. To replay, retrieve the input from the `agent_runs` table
and call the agent directly:

```bash
curl -X POST https://agent-runtime:8000/agents/parikshan/invoke \
  -H "X-Internal-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "correlation_id": "<original-correlation-id>",
    "input": { ... }
  }'
```

The replay produces a new audit chain under the same correlation_id;
both chains are visible in the ledger for forensic comparison.

### Onboard a new tenant

1. Create the tenant in the Supabase dashboard (or via the configured BFF
   admin path when that deployment capability is enabled).
2. Insert into `tenants` (use the founder's session for now).
3. Invite the user's first admin via the BFF `POST /v1/tenants/{id}/users`
   when enabled in the deployment, or directly in Supabase during the current
   controlled rollout.
4. Set the per-tenant approval signing key in Secrets Manager.
5. Schedule the first discovery scan with the founder.

### Offboard a tenant

Per the DPDPA: when a tenant offboards, their personal data is erased
from active systems within a reasonable time. The audit ledger
entries are RETAINED (they are the proof that the data was processed
in compliance with the Act) but are scoped to a "tombstoned" tenant
record. Evidence is sealed; a soft-delete flag is set on the tenant
row; RLS hides it from future queries; a `tenant.updated` event is
written to the ledger.

```sql
UPDATE tenants SET deleted_at = now() WHERE id = '<tenant-uuid>';
```

The hard-delete is intentionally impossible: the evidence vault's
Object Lock Compliance mode is WORM, and the audit ledger is
append-only. Personal data inside the tenants' own data (e.g.
DSARs, engagement records) is erased via Saakshi-generated erasure
artifacts that are themselves sealed into the vault.

---

## Alerting (Phase 2+)

| Signal                                   | Threshold          | Action                                |
| ---------------------------------------- | ------------------ | ------------------------------------- |
| `audit_ledger` chain break               | any                | PagerDuty: founder + on-call          |
| Kill switch engaged                      | any                | Slack: #axiom-prod                    |
| Agent run failure                        | > 5% over 1h       | Slack: #axiom-prod                    |
| BFF 5xx rate                             | > 1% over 5m       | PagerDuty: on-call                    |
| Model gateway PII redaction failures     | > 0                | PagerDuty: founder (potential bypass) |
| S3 evidence Object Lock retention expiry | any within 30 days | Slack: #axiom-prod                    |
| Approval token signature mismatch        | any                | PagerDuty: founder (security)         |
| Per-tenant cost > 15% of ACV             | monthly check      | Founder review                        |

These are configured in CloudWatch Alarms + PagerDuty (Phase 2+).
The Phase 0/1 manual equivalent is the daily/weekly/monthly checklist
above.
