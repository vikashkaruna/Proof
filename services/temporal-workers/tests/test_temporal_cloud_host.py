from temporal_workers.worker import _is_temporal_cloud


def test_matches_temporal_cloud_hosts_exactly() -> None:
    assert _is_temporal_cloud("ap-south-1.aws.api.temporal.io:7233")
    assert _is_temporal_cloud("ns.acct.tmprl.cloud:7233")
    assert not _is_temporal_cloud("temporal.io.attacker.example:7233")
    assert not _is_temporal_cloud("tmprl.cloud-proxy.example:7233")
    assert not _is_temporal_cloud("localhost:7233")
