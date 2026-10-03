-- Archive release is a founder decision and appends a human-labelled event.
-- The archive writer must not retain a parallel path to that decision.
revoke execute on function public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  from approval_archive_writer;
grant execute on function public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  to human_action_writer;
