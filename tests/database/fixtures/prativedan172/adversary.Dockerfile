FROM axiom-proof-local-prativedan172-fixture-normal:164a26c6
USER 0:0
COPY --chmod=0644 prativedan_pure_worker.py /app/services/agent-runtime/src/axiom/prativedan_pure_worker.py
USER 20107:20107
LABEL com.axiom.fixture="prativedan172-source-process" com.axiom.adversary="unexpected-complete-and-detached-child"
