-- Revision 109 safety gate. Earlier board/statutory generators recorded PDF
-- digests and provider-looking locations without retaining a verified object
-- version. A founder review alone must not publish these artifacts. This gate
-- stays until a later append-only migration supplies exact-byte receipts.
create or replace function public.release_report(p_tenant_id uuid,p_report_id uuid,p_released_by uuid,
 p_expected_content_hash text,p_expected_archive_hash text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reports;p public.evidence_packs;a public.evidence_pack_archives;v_review public.report_reviews;v_time timestamptz:=clock_timestamp();
begin
 if not public.report_founder_allowed(p_tenant_id,p_released_by) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_expected_content_hash is null or p_expected_content_hash !~ '^[0-9a-f]{64}$'
  or (p_expected_archive_hash is not null and p_expected_archive_hash !~ '^[0-9a-f]{64}$') then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found then return jsonb_build_object('error','report_not_found'); end if;
 if r.content_text is null then return jsonb_build_object('error','legacy_report_requires_revision'); end if;
 if r.content_sha256<>p_expected_content_hash then return jsonb_build_object('error','manifest_changed'); end if;
 if r.status not in ('approved','published') then return jsonb_build_object('error','not_approved'); end if;
 select * into v_review from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if not found or v_review.decision<>'approved' or v_review.content_sha256 is distinct from r.content_sha256
  or r.reviewed_content_hash is distinct from r.content_sha256 then return jsonb_build_object('error','not_approved'); end if;

 -- 0075/0079 do not persist exact verified PDF bytes or source receipts.
 -- Their metadata rows can be created from arbitrary caller content or a
 -- synthetic storage key, so neither is publication proof.
 if r.generated_by_agent = 'prativedan'
  or exists(select 1 from public.board_report_artifacts where tenant_id=p_tenant_id and report_id=r.id)
  or exists(select 1 from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id) then
  return jsonb_build_object('error','report_artifact_unverified');
 end if;

 select * into p from public.evidence_packs where tenant_id=p_tenant_id and report_id=r.id;
 if found then
  select a0.* into a from public.evidence_pack_archives a0 join public.evidence_pack_builds b on b.tenant_id=a0.tenant_id and b.id=a0.build_id
   where a0.tenant_id=p_tenant_id and a0.pack_id=p.id and b.status='settled';
  if not found then return jsonb_build_object('error','build_not_settled'); end if;
  if p_expected_archive_hash is distinct from a.content_hash then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 elsif p_expected_archive_hash is not null then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 if r.status='published' then
  if r.released_content_hash is distinct from p_expected_content_hash or r.released_archive_hash is distinct from p_expected_archive_hash then
   return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('reportId',r.id,'status','published','contentHash',r.released_content_hash,'archiveHash',r.released_archive_hash,'replayed',true);
 end if;
 update public.reports set status='published',published_at=v_time,released_by=p_released_by,released_content_hash=r.content_sha256,
  released_archive_hash=p_expected_archive_hash where tenant_id=p_tenant_id and id=r.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_released_by::text,null,null,null,'report.released',r.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('content_hash',r.content_sha256,'archive_hash',p_expected_archive_hash,'review_id',v_review.id));
 return jsonb_build_object('reportId',r.id,'status','published','contentHash',r.content_sha256,'archiveHash',p_expected_archive_hash,'replayed',false);
end $$;

revoke all on function public.release_report(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.release_report(uuid,uuid,uuid,text,text,uuid) to service_role;

-- A synthetic key/version must not be recorded as if Object Lock readback
-- happened. Existing metadata stays for historical inspection only.
revoke execute on function public.attach_board_report_pdf(uuid,uuid,uuid,text,bigint,text,text,text,text,timestamptz) from service_role;
