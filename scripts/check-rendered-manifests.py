#!/usr/bin/env python3
"""Assert the rendered chart means what it says.

`helm template` and kubeconform prove a manifest is well-formed and schema-valid.
They cannot prove it is correct, and every defect this file checks for rendered
as perfectly valid YAML for the chart's whole life:

- Both NetworkPolicies that grant access selected on a label the pod templates
  never carried, so they matched zero pods while the default-deny matched all
  of them. Every workload had DNS and nothing else.
- A marketing Service and an Ingress rule for the public site pointed at a
  Deployment that did not exist. The site answered 503.
- bff and agent-runtime omitted `replicas` to hand the count to an HPA the
  chart never shipped, so they ran one pod each against PodDisruptionBudgets
  with minAvailable: 1 — a floor equal to the count, which permits zero
  voluntary evictions and stalls a node drain indefinitely.

Reads a rendered manifest stream on stdin. Exits non-zero on the first
category with findings, listing all of them.

    check-rendered-manifests.py [--expect-components a,b,c] < rendered.yaml
"""

import argparse
import sys

import yaml


def selects(selector: dict | None, labels: dict) -> bool:
    """A Kubernetes label selector with no matchLabels selects everything."""
    if not selector:
        return True
    match = selector.get("matchLabels") or {}
    if not match:
        return True
    return all(labels.get(k) == v for k, v in match.items())


def main() -> int:
    ap = argparse.ArgumentParser()
    # temporal-worker has no Service and no Ingress rule, so nothing in the
    # rendered output referred to it and its total absence was invisible to
    # every other check here. The bundled components are named explicitly for
    # the same reason check-mfa-ring-coverage.sh names its six surfaces: the
    # defect is something MISSING, and only a declared expectation sees that.
    ap.add_argument("--expect-components", default="")
    args = ap.parse_args()
    expected = [c for c in args.expect_components.split(",") if c]

    docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
    by_kind: dict[str, list] = {}
    for d in docs:
        by_kind.setdefault(d["kind"], []).append(d)

    # name -> (pod labels, replica floor). The floor is what a PDB has to stay
    # strictly below, and an HPA's minReplicas supersedes spec.replicas.
    workloads: dict[str, tuple[dict, int]] = {}
    for d in by_kind.get("Deployment", []):
        spec = d["spec"]
        workloads[d["metadata"]["name"]] = (
            spec["template"]["metadata"].get("labels") or {},
            # Absent `replicas` means the API server defaults to 1.
            spec.get("replicas", 1),
        )

    hpa_targets = {}
    for h in by_kind.get("HorizontalPodAutoscaler", []):
        ref = h["spec"]["scaleTargetRef"]
        if ref["kind"] == "Deployment":
            hpa_targets[ref["name"]] = h["spec"].get("minReplicas", 1)

    all_labels = [labels for labels, _ in workloads.values()]
    errors: list[str] = []

    # 0. Every bundled component must actually have a workload.
    deployed = {lbl.get("app.kubernetes.io/component") for lbl in all_labels}
    for component in expected:
        if component not in deployed:
            errors.append(f"component '{component}' is bundled but has no Deployment")

    # 1. A Service that selects nothing is a published endpoint with no backend.
    for s in by_kind.get("Service", []):
        sel = s["spec"].get("selector") or {}
        if not any(all(lbl.get(k) == v for k, v in sel.items()) for lbl in all_labels):
            errors.append(f"Service/{s['metadata']['name']} selects no pod: {sel}")

    # 2. A NetworkPolicy that selects nothing is a rule that never applies. It
    #    is silent: nothing errors, traffic is simply denied by the default.
    for p in by_kind.get("NetworkPolicy", []):
        sel = p["spec"].get("podSelector")
        if sel and sel.get("matchLabels") and not any(selects(sel, lbl) for lbl in all_labels):
            errors.append(
                f"NetworkPolicy/{p['metadata']['name']} selects no pod: {sel['matchLabels']}"
            )

    # 2b. A NetworkPolicy decision needs BOTH the sender's egress and the
    #     receiver's ingress. The data-plane policy carried only the egress
    #     half, so under the default-deny every Service port except the public
    #     3000 admitted nothing and service-to-service calls were dropped.
    deny_all_ingress = any(
        not (p["spec"].get("podSelector") or {}).get("matchLabels")
        and "Ingress" in (p["spec"].get("policyTypes") or [])
        for p in by_kind.get("NetworkPolicy", [])
    )
    if deny_all_ingress:
        for svc in by_kind.get("Service", []):
            sel = svc["spec"].get("selector") or {}
            ports = [p["port"] for p in svc["spec"].get("ports") or []]
            for name, (labels, _) in workloads.items():
                if not all(labels.get(k) == v for k, v in sel.items()):
                    continue
                for port in ports:
                    if not any(
                        selects(p["spec"].get("podSelector"), labels)
                        and "Ingress" in (p["spec"].get("policyTypes") or [])
                        and any(
                            not rule.get("ports")
                            or any(pt.get("port") == port for pt in rule["ports"])
                            for rule in (p["spec"].get("ingress") or [])
                        )
                        for p in by_kind.get("NetworkPolicy", [])
                    ):
                        errors.append(
                            f"Service/{svc['metadata']['name']} port {port} reaches "
                            f"Deployment/{name}, but no NetworkPolicy admits it under default-deny"
                        )

    # 3. An HPA pointing at nothing scales nothing, and a Deployment that
    #    omitted `replicas` for an HPA that is absent silently runs one pod.
    for name in hpa_targets:
        if name not in workloads:
            errors.append(f"HorizontalPodAutoscaler/{name} targets a Deployment that is absent")
    for d in by_kind.get("Deployment", []):
        name = d["metadata"]["name"]
        if "replicas" not in d["spec"] and name not in hpa_targets:
            errors.append(
                f"Deployment/{name} omits `replicas` with no HorizontalPodAutoscaler: runs one pod"
            )

    # 4. minAvailable at or above the replica floor permits zero voluntary
    #    evictions, so `kubectl drain` blocks forever instead of rescheduling.
    for pdb in by_kind.get("PodDisruptionBudget", []):
        spec = pdb["spec"]
        min_avail = spec.get("minAvailable")
        if not isinstance(min_avail, int):
            continue
        for name, (labels, replicas) in workloads.items():
            if not selects(spec.get("selector"), labels):
                continue
            floor = hpa_targets.get(name, replicas)
            if min_avail >= floor:
                errors.append(
                    f"PodDisruptionBudget/{pdb['metadata']['name']} has minAvailable={min_avail} "
                    f"against Deployment/{name} floor={floor}: permits zero voluntary evictions"
                )

    if errors:
        print(f"✗ {len(errors)} finding(s) in the rendered manifests:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(
        f"✓ {len(docs)} resources: services backed, network policies bind, "
        f"replica floors and disruption budgets consistent"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
