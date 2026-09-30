# Offline recovery acceptance

`scripts/test-backup-restore.sh` has two deliberately distinct modes. The default `diagnostic` mode makes a fresh PostgreSQL dump, restores it into a disposable database, compares schema, RLS and audit-chain fingerprints, and measures only the local drill duration. It reports RPO and evidence recovery as **unverified**. It requires `AXIOM_RESTORE_SOURCE_DB` and an explicit `AXIOM_RESTORE_DB_CONTAINER` or `DATABASE_URL`; it refuses the `postgres` maintenance database as the source. For the sovereign Compose installation, the source database is `axiom_onprem`.

The `scheduled` mode is the W9/W10 recovery acceptance path. It restores an already scheduled dump, not a new snapshot. It requires the on-prem Compose `supabase-db` container, an operator incident timestamp, a signed manifest, every backed-up retained object version, an empty separate Object Lock bucket, and the protected on-prem environment file. It refuses a foreign Compose project. The script restores the database into a disposable database, verifies its tables, RLS and complete ledger chain, discovers every public retained-version table by its persisted `bucket/object_key/version_id/content_hash/byte_size` columns, and compares every restored reference with the signed object inventory. It then runs the locked agent-runtime image on the internal-only sovereign network to re-upload each backed-up object to the separate restore bucket and read back its exact new version, hash, length, AES256 encryption, Compliance retention and legal-hold state. The source bucket is never overwritten.

The manifest is a private regular JSON file (0600) with keys `schemaVersion`, `sourceDatabase`, `sourceBucket`, `backupAt`, `database`, `evidence` and `signature`. `database` contains `sha256`, `byteSize`, `ledgerFingerprint` (`count:sha256`), `tableCount` and `rlsCount`. Each `evidence` entry contains a backup-root-relative `path`, original `key`, `sourceVersionId`, `sha256`, `byteSize`, `retainUntil` and `legalHold` (Boolean). The backup scheduler must write the manifest at backup time, with `signature = HMAC-SHA256(bytes.fromhex(AXIOM_RECOVERY_MANIFEST_KEY), canonical_json_without_signature)`, where canonical JSON uses sorted keys, `(',', ':')` separators and UTF-8 without ASCII escaping. Keep this key distinct from application approval/JWT/storage keys and protected by the backup scheduler; signing an after-the-fact inventory is not scheduled-backup evidence. The signed manifest binds the database dump and object bytes. The script requires the signed backup to precede the supplied incident time by no more than one hour and gates both the drill duration and incident-to-recovery time at four hours.

Example with operator-provided protected inputs (values are not printed):

```bash
export AXIOM_RESTORE_MODE=scheduled
export AXIOM_RESTORE_SOURCE_DB=axiom_onprem
export AXIOM_RESTORE_DB_CONTAINER=<exact owned supabase-db container ID>
export AXIOM_RECOVERY_MANIFEST=<private signed scheduled manifest>
export AXIOM_SCHEDULED_DB_DUMP=<scheduled PostgreSQL dump>
export AXIOM_EVIDENCE_BACKUP_ROOT=<read-only backed-up object files>
export AXIOM_RECOVERY_INCIDENT_AT=<incident timestamp with UTC offset>
export AXIOM_RECOVERY_MANIFEST_KEY=<distinct secret injected by backup authority>
export AXIOM_RESTORE_S3_BUCKET=<empty separate ap-south-1 Compliance bucket>
export AXIOM_ONPREM_ENV_FILE=<protected on-prem environment file>
bash scripts/test-backup-restore.sh
```

The restore target's pinned agent-runtime image supplies locked boto3 and its existing on-prem storage credentials. `AXIOM_RESTORE_S3_ENDPOINT` is fixed to `http://minio:9000` on the Compose network, which is `internal: true`; the helper rejects an external endpoint. The target bucket must already exist with a seven-year S3 Object Lock Compliance default. An approved scheduled-backup producer, real signed backup and object inventory, approved offline image digests, valid license, empty locked restore bucket, and an egress-blocked live persona/install/upgrade/recovery run are still required before W9 or W10 closure. Unit and command-path tests use synthetic files/mocks and cannot substitute for those live gates.
