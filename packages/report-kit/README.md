# Evidence pack v1

`@axiom/report-kit/schema` (also the package root) exports browser-safe strict manifest/review schemas, types, branding and limits. `@axiom/report-kit/archive` is Node-only. It preserves the exact database-generated UTF-8 `manifest_text` and approved `review_text`, checks their stored SHA-256 values, binds the named review to the manifest and pack, and checks each supplied member against its recorded size/hash before writing a deterministic stored ZIP. It does not authorize review/release or contact storage; the BFF and database enforce those boundaries.

ZIP entry order is `manifest.json`, `review.json`, `README.txt`, `verify_evidence_pack.py`, then evidence members sorted by UUID. Paths are `evidence/<evidence_id>.bin`; display filenames never become paths. All entries are regular non-executable files with fixed DOS timestamp 1980-01-01 00:00:00. This timestamp is archive metadata, not collection/approval time. Actual UTC timestamps remain in the manifest/review. UTC and Asia/Kolkata produce identical ZIP bytes for the same inputs and verifier source.

Limits are 20 members, 8 MiB/member, 48 MiB total member bytes, 256 KiB per metadata entry and 64 MiB/archive. Exact-text serialization is `postgres-jsonb-text-v1`; do not normalize or reserialize the manifest or review. Changing verifier source changes archive bytes; an existing durable build request must retain its original archive digest and cannot silently adopt a rebuilt artifact.

## Independent verification

Obtain the released archive SHA-256 and this verifier through separately trusted channels. The release digest is separate from the archive and has no circular self-reference. Obtain the verifier from a trusted application source revision; an unverified bundled copy is not a trust anchor. Do not execute scripts extracted from an unverified archive.

With Python 3.11 or newer (standard library only):

```bash
python3 packages/report-kit/python/verify_evidence_pack.py downloaded-pack.zip \
  --expected-archive-sha256 '<released archive SHA-256>' \
  --expected-manifest-sha256 '<reviewed manifest SHA-256>'
```

The manifest digest argument is optional. The released archive digest is mandatory. The verifier takes a bounded snapshot of a regular file, checks its outer digest before parsing, validates strict ZIP headers and limits before constructing a ZIP index, then checks exact manifest/review binding and every member's actual bytes. It rejects duplicate entries/JSON keys, traversal, symlinks, executable modes, compressed/encrypted/ZIP64 layouts, overlap, unexpected files, invalid Unicode, oversized declarations and CRC corruption. It never extracts or executes archive contents. Exit 0 emits a minimal JSON verification receipt; exit 1 reports refusal without exposing member values.

Matching hashes prove agreement with the supplied trust anchor, not authenticity of an independently untrusted anchor, a cryptographic signature, source provenance or compliance completeness. An approved review records a named human's decision; offline verification cannot independently establish that person's identity or live authority. Current database preparation admits only human-submitted receipts; future schema values do not grant eligibility. Reference/sandbox sources are refused. Provider retention and exact-version readback remain online responsibilities.

## Validation

`pnpm --filter @axiom/report-kit test` covers deterministic cross-timezone output, exact text/hash binding, named review binding, byte limits and cross-language verification. It also runs the independent stdlib Python test suite, whose malicious ZIPs carry matching outer digests so parser defenses are exercised. `pnpm --filter @axiom/report-kit typecheck` checks the TypeScript API.
