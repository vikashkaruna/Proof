/** Delivered as a standalone standard-library Python tool inside the pack. */
export const FULL_CLOSURE_OFFLINE_VERIFIER = String.raw`#!/usr/bin/env python3
"""Verify bytes against independently obtained digests; no legal certification."""
import argparse
import hashlib
import json
import re
import sys
import zipfile


def need(value):
    if not value:
        raise ValueError("integrity check refused")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def pairs(values):
    result = {}
    for key, value in values:
        need(key not in result)
        result[key] = value
    return result


def decode(value):
    return json.loads(value, object_pairs_hook=pairs)


def verify(args):
    for value in (args.archive_sha256, args.manifest_sha256):
        need(re.fullmatch(r"[a-f0-9]{64}", value))
    with open(args.archive, "rb") as stream:
        archive = stream.read(67108865)
    need(len(archive) <= 67108864 and digest(archive) == args.archive_sha256)
    with zipfile.ZipFile(args.archive) as pack:
        infos = pack.infolist()
        need(1 <= len(infos) <= 140 and len({v.filename for v in infos}) == len(infos))
        need(sum(v.file_size for v in infos) <= 67108864)
        for member in infos:
            need(member.compress_type == zipfile.ZIP_STORED)
            need(re.fullmatch(r"manifest\.json|closure-source\.json|reconciliation_statement\.json|ledger_chain_receipt\.json|README\.txt|verify_full_closure\.py|components/[a-f0-9-]{36}\.(zip|json|bin)", member.filename))
        files = {v.filename: pack.read(v) for v in infos}
    need(digest(files["manifest.json"]) == args.manifest_sha256)
    manifest = decode(files["manifest.json"])
    need(manifest["schema_version"] == 1 and manifest["kind"] == "pramaan_full_closure_archive")
    scope = (args.tenant, args.engagement, args.report)
    need(tuple(manifest[k] for k in ("tenant_id", "engagement_id", "board_report_id")) == scope)
    members = manifest["members"]
    need(len(members) == len(files)-1 and len({v["path"] for v in members}) == len(members))
    for member in members:
        path = member["path"]
        need(path != "manifest.json" and path in files)
        need(len(files[path]) == member["byte_size"] and digest(files[path]) == member["sha256"])
    need(digest(files["closure-source.json"]) == manifest["source_sha256"])
    source = decode(files["closure-source.json"])
    need(source["schema_version"] == 1 and source["kind"] == "full_closure_source")
    need(tuple(source[k] for k in ("tenant_id", "engagement_id", "board_report_id")) == scope)
    need(source["statutory_completeness_asserted"] is False and source["independent_audit_asserted"] is False)
    need(1 <= len(source["findings"]) <= 500 and all(v["status"] == "closed" for v in source["findings"]))
    need(1 <= len(source["plans"]) <= 50 and all(v["status"] == "completed" for v in source["plans"]))
    components = source["components"]
    kinds = {"board_executive", "auditor_assurance", "technical_register", "approval_proof", "evidence"}
    need(5 <= len(components) <= 128 and {v["kind"] for v in components} == kinds)
    need(len({v["id"] for v in components}) == len(components) and sum(v["byte_size"] for v in components) <= 50331648)
    for component in components:
        need((component["tenant_id"], component["engagement_id"]) == scope[:2])
        need(component["version_id"] and component["version_id"] != "null")
        extension = "json" if component["kind"] == "approval_proof" else "bin" if component["kind"] == "evidence" else "zip"
        content = files["components/"+component["id"]+"."+extension]
        need(len(content) == component["byte_size"] and digest(content) == component["content_hash"])
    previous = None
    chain = source["ledger_chain"]
    need(1 <= len(chain) <= 5000)
    for index, entry in enumerate(chain, 1):
        need(entry["sequence_no"] == str(index) and entry["previous_hash"] == previous)
        need(digest(entry["payload_text"].encode("utf8")) == entry["entry_hash"])
        fields = entry["payload_text"].split("|")
        need(fields[0] == str(index) and fields[17] == (previous or ""))
        previous = entry["entry_hash"]
    need(previous == source["ledger_head"] and source["as_of_sequence"] == str(len(chain)))
    nodes = [hashlib.sha256(b"\x00"+bytes.fromhex(v)).digest() for v in [manifest["source_sha256"]]+[v["content_hash"] for v in components]]
    while len(nodes)>1:
        nodes = [hashlib.sha256(b"\x01"+nodes[i]+(nodes[i+1] if i+1<len(nodes) else nodes[i])).digest() for i in range(0,len(nodes),2)]
    need(nodes[0].hex() == manifest["merkle_root"])
    need(1 <= len(source["reconciliations"]) <= 100)
    need(decode(files["reconciliation_statement.json"]) == source["reconciliations"])
    need(decode(files["ledger_chain_receipt.json"]) == {"tenant_id":source["tenant_id"],"as_of_sequence":source["as_of_sequence"],"head":source["ledger_head"],"entries":chain})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    for name in ("archive-sha256", "manifest-sha256", "tenant", "engagement", "report"):
        parser.add_argument("--"+name, required=True)
    args = parser.parse_args()
    try:
        verify(args)
    except (ValueError, KeyError, TypeError, IndexError, OSError, zipfile.BadZipFile):
        print("REFUSED: archive integrity, scope or independently supplied digest mismatch.", file=sys.stderr)
        return 1
    print("VERIFIED: recorded bytes, scope, exact source members, ledger prefix and Merkle root. No independent audit or legal certification asserted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
