-- Forward-only: remove the dispatch RPCs that 0021 superseded.
--
-- 0019 shipped `record_execution_dispatch` and 0020 shipped
-- `settle_execution_dispatch`. 0021 replaced both with
-- `finish_execution_dispatch`, which settles the actions and the outbox row in
-- one transaction under the plan lock and refuses to downgrade a delivered
-- intent. The BFF was moved over in the same commit.
--
-- Nothing calls the old two any more, but both were still granted to
-- `service_role`, and a dead grant on a security-definer function is not
-- inert. They encode exactly the semantics 0021 corrected:
--
--   · `record_execution_dispatch` releases the claim on any 'failed' outcome —
--     `execution_status` back to 'approved', `execution_request_key` to null —
--     with no plan lock, no delivered-guard and no outbox coupling. The whole
--     point of the correction is that only an EXPLICIT refusal may release
--     actions; an unreachable runtime or a lost acknowledgement must not,
--     because the work may be running on a client's estate. This function
--     cannot tell those apart: the caller hands it a status.
--
--   · `settle_execution_dispatch` moves an outbox row to 'delivered' without
--     touching the actions. That desynchronises the two records, and it is
--     worse than untidy: `finish_execution_dispatch` only acts on a row in
--     ('pending', 'unknown'), so once a row has been marked delivered out of
--     band the real outcome arrives, finds nothing to settle, returns false
--     and is lost.
--
-- Dropping them is the only way to make the corrected path the ONLY path.
-- Retiring a function is not the same as retiring the data: the outbox rows,
-- the claims and their history are untouched.
begin;

drop function if exists public.record_execution_dispatch(uuid, uuid, text, text, text, text);
drop function if exists public.settle_execution_dispatch(uuid, uuid, text, text, text);

commit;
