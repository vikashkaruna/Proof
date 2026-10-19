FROM axiom-proof-local-prativedan172-fixture-base:164a26c6
USER 0:0
COPY --chmod=0644 assessment_supervisor.py prativedan_accounted_process.py prativedan_accounted_supervisor.py prativedan_pure_worker.py prativedan_pure_supervisor.py /app/services/agent-runtime/src/axiom/
RUN ln -s /app/services/agent-runtime/src /worker && ln -s /app/packages/model-accounting-python/axiom_model_accounting.py /app/services/agent-runtime/src/axiom_model_accounting.py && ln -s /app/packages/offline-license-python/axiom_offline_license.py /app/services/agent-runtime/src/axiom_offline_license.py
WORKDIR /worker
RUN env -i PATH=/usr/local/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 /app/services/agent-runtime/.venv/bin/python -c "from axiom.prativedan_accounted_process import compute_zero_only; from axiom.prativedan_pure_worker import main; print('empty-environment module imports passed')"
USER 20107:20107
LABEL com.axiom.fixture="prativedan172-source-process" org.opencontainers.image.revision="164a26c60f6b8627bb6bf44a4090fe9d7bf02d14"
