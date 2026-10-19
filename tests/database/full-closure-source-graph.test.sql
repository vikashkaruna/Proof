-- Prefix is emitted by lib/full-closure-source-graph.py: actual assessment
-- finalization, board/auditor/technical request/draft/review/artifact/release and
-- token/dry-run/execution/verification/signed-reconciliation/proof-release RPCs.
-- Provider receipts are synthetic only, with all normal constraints enabled.
-- No authoritative source supplier or view is replaced in this suite.
do $$declare
 t uuid:='99880000-0000-4000-8000-000000000010';m uuid:='99880000-0000-4000-8000-000000000001';f uuid:='99880000-0000-4000-8000-000000000002';r public.reports;s public.board_artifact_versions;p public.board_artifact_versions;
 op uuid:=gen_random_uuid();x jsonb;q jsonb;d uuid;b uuid;receipt jsonb;src jsonb;frozen text;eid uuid:=gen_random_uuid();ingestion uuid:=gen_random_uuid();source_digest text;
begin
 select * into r from public.reports where tenant_id=t and kind='board' and status='published';
 select * into s from public.board_artifact_versions where tenant_id=t and report_id=r.id and artifact_kind='source_json';
 select * into p from public.board_artifact_versions where tenant_id=t and report_id=r.id and artifact_kind='board_pdf';
 q:=jsonb_build_object('provider','s3-compatible','bucket','board-test','source_sha256',s.content_hash,'pdf_sha256',p.content_hash,'source_version_id',s.id,'pdf_version_id',p.id,'manifest_sha256',repeat('c',64),'archive_sha256',repeat('d',64),'archive_bytes',2000,'object_key','tenants/'||t||'/pramaan/'||r.id||'/'||op||'/'||repeat('d',64));
 x:=public.begin_source_bound_pramaan(t,m,r.id,op,'Board closure fixture',q,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','actual released board report begins source dossier');d:=(x->>'dossierId')::uuid;b:=(x->>'buildId')::uuid;
 receipt:=jsonb_build_object('provider','s3-compatible','bucket','board-test','object_key',q->>'object_key','version_id','board-dossier-exact','content_hash',repeat('d',64),'byte_size',2000,'tenant_id',t,'engagement_id',r.engagement_id,'collected_by_agent','pramaan','retain_until',(select retain_until+interval '1 second' from public.pramaan_dossier_builds where id=b),'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256','operation_id',b,'correlation_id',(select correlation_id from public.pramaan_dossier_builds where id=b));
 perform pg_temp.ok(public.settle_source_bound_pramaan(t,m,b,receipt,gen_random_uuid())->>'status'='settled','board dossier exact version settles');
 perform pg_temp.ok(public.seal_source_bound_pramaan(t,f,d,(select proof_seal_hash from public.pramaan_dossiers where id=d),gen_random_uuid())->>'status'='sealed','actual founder seal receipt');
 begin perform public.read_full_closure_source(t,m,r.id);raise exception 'ASSERTION FAILED: open findings accepted';exception when check_violation then perform pg_temp.ok(sqlerrm='all_recorded_findings_must_be_closed','open finding refused before complete closure: '||sqlerrm);end;
 update public.findings set status='closed' where tenant_id=t and engagement_id=r.engagement_id;
 begin perform public.read_full_closure_source(t,m,r.id);raise exception 'ASSERTION FAILED: URI-only evidence accepted';exception when check_violation then perform pg_temp.ok(sqlerrm='retained_finding_evidence_required','actual retained evidence required');end;
 insert into public.evidence(id,tenant_id,engagement_id,content_hash,storage_uri,byte_size,evidence_type,collected_by_agent)
 values(eid,t,r.engagement_id,repeat('e',64),'s3://axiom-proof-local-evidence/synthetic',10,'document','human');
 insert into public.evidence_ingestions(id,tenant_id,operation_key,engagement_id,actor_id,correlation_id,request,retain_until,status,evidence_id,settled_at)
 values(ingestion,t,gen_random_uuid(),r.engagement_id,m,gen_random_uuid(),'{}',clock_timestamp()+interval '7 years','settled',eid,clock_timestamp());
 insert into public.evidence_object_versions(tenant_id,evidence_id,ingestion_id,provider,bucket,object_key,version_id,content_hash,byte_size,lock_mode,retain_until,readback_at,legal_hold,encryption,receipt,verified_by)
 values(t,eid,ingestion,'s3-compatible','axiom-proof-local-evidence','synthetic','evidence-exact',repeat('e',64),10,'COMPLIANCE',clock_timestamp()+interval '7 years',clock_timestamp(),false,'AES256','{}',m);
 insert into public.finding_evidence(tenant_id,finding_id,evidence_id,link_type) select t,id,eid,'demonstrates' from public.findings where tenant_id=t and engagement_id=r.engagement_id;
 src:=public.read_full_closure_source(t,m,r.id);frozen:=src->>'sourceText';source_digest:=src->>'sourceSha256';
 perform pg_temp.ok(encode(sha256(convert_to(frozen,'UTF8')),'hex')=source_digest,'authoritative complete source exact hash');
 perform pg_temp.ok(frozen::jsonb#>>'{findings,0,closing_actions,0,plan_id}'='10000000-0000-4000-8000-000000000030','finding-to-action-to-plan proof linkage retained');
 perform pg_temp.ok(jsonb_array_length(frozen::jsonb->'components')=5,'all five real source kinds composed');
 perform pg_temp.ok(jsonb_array_length(frozen::jsonb->'reconciliations')=1,'actual signed reconciliation included');
 perform pg_temp.ok((frozen::jsonb->>'as_of_sequence')::bigint=(select max((v->>'sequence_no')::bigint) from jsonb_array_elements(frozen::jsonb->'ledger_chain')v),'ledger prefix complete through source seal');
 op:=gen_random_uuid();q:=jsonb_build_object('provider','s3-compatible','bucket','axiom-proof-local-evidence','source_sha256',source_digest,'manifest_sha256',repeat('a',64),'archive_sha256',repeat('b',64),'archive_bytes',1234,'merkle_root',controller_security.full164_merkle(source_digest,frozen::jsonb->'components'),'object_key','tenants/'||t||'/pramaan/full/'||r.id||'/'||op||'/'||repeat('b',64));
 x:=public.begin_full_pramaan(t,m,r.id,op,'Complete actual source graph',frozen,q,gen_random_uuid());
 perform pg_temp.ok(x->>'status'='pending','real authoritative source begins full lifecycle');d:=(x->>'dossierId')::uuid;b:=(x->>'buildId')::uuid;
 receipt:=jsonb_build_object('provider','s3-compatible','bucket',q->>'bucket','object_key',q->>'object_key','version_id','full-graph-exact','content_hash',repeat('b',64),'byte_size',1234,'tenant_id',t,'engagement_id',r.engagement_id,'collected_by_agent','pramaan','operation_id',b,'correlation_id',(select correlation_id from public.pramaan_full_builds where id=b),'retain_until',(select retain_until+interval '1 day' from public.pramaan_full_builds where id=b),'readback_at',clock_timestamp(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,'encryption','AES256');
 perform pg_temp.ok(public.settle_full_pramaan(t,m,b,receipt,gen_random_uuid())->>'status'='settled','complete source archive settles');
 perform pg_temp.ok(public.read_full_closure_source(t,m,r.id)->>'sourceSha256'=source_digest,'own lifecycle ledger events do not drift frozen source');
 perform pg_temp.ok(public.review_full_pramaan(t,f,d,repeat('b',64),'full-graph-exact','Reviewed all source graph members',gen_random_uuid())->>'status'='approved','real graph founder review');
 perform pg_temp.ok(public.seal_full_pramaan(t,f,d,(select proof_seal_hash from public.pramaan_dossiers where id=d),gen_random_uuid())->>'status'='sealed','real graph founder seal');
 perform pg_temp.ok(public.release_full_pramaan(t,f,d,repeat('b',64),'full-graph-exact',gen_random_uuid())->>'status'='released','real graph founder release');
 -- New recorded work invalidates another full closure; an old release remains
 -- immutable and readable by exact retained version, rather than rewritten.
 insert into public.remediation_plans(tenant_id,engagement_id,library_version,title) values(t,r.engagement_id,'statutory-test-lib','New unresolved scope');
 begin perform public.read_full_closure_source(t,m,r.id);raise exception 'ASSERTION FAILED: unresolved added plan accepted';exception when check_violation then perform pg_temp.ok(sqlerrm='completed_plans_required','new unresolved work refuses new closure');end;
 perform pg_temp.ok((select count(*)=1 from public.pramaan_full_releases where dossier_id=d),'historical release survives changed current scope');
end $$;
rollback;
