-- 0164: full closure is an explicit composition of released exact-version
-- sources. No historical row or source-free Python output can enter this gate.
alter type public.ledger_action_type add value if not exists 'closure.pramaan.reviewed';
alter type public.ledger_action_type add value if not exists 'closure.pramaan.released';

create view controller_security.full164_components as
 select d.tenant_id,d.engagement_id,d.report_id,d.id as dossier_id,d.dossier_type::text as kind,d.sealed_at,
 a.id,a.build_id as operation_id,a.provider,a.bucket,a.object_key,a.version_id,a.content_hash,a.byte_size,
 a.retain_until,a.encryption,'pramaan'::text as collected_by_agent,d.proof_seal_hash,
 b.source_version_id,b.pdf_version_id,r.library_version
 from public.pramaan_dossiers d join public.pramaan_dossier_builds b on b.tenant_id=d.tenant_id and b.dossier_id=d.id
 join public.pramaan_dossier_archives a on a.tenant_id=d.tenant_id and a.build_id=b.id
 join public.reports r on r.tenant_id=d.tenant_id and r.id=d.report_id
 where d.status='sealed' and d.dossier_type='board_executive' and b.status='settled' and r.status='published'
 and r.kind='board' and d.archive_hash=a.content_hash and d.archive_bytes=a.byte_size and a.lock_mode='COMPLIANCE'
 union all
 select d.tenant_id,d.engagement_id,d.report_id,d.id,d.dossier_type::text,d.sealed_at,
 a.id,a.build_id,a.provider,a.bucket,a.object_key,a.version_id,a.content_hash,a.byte_size,a.retain_until,a.encryption,'pramaan',d.proof_seal_hash,b.source_version_id,b.pdf_version_id,r.library_version
 from public.pramaan_dossiers d join public.pramaan_auditor_builds b on b.tenant_id=d.tenant_id and b.dossier_id=d.id
 join public.pramaan_auditor_archives a on a.tenant_id=d.tenant_id and a.build_id=b.id
 join public.reports r on r.tenant_id=d.tenant_id and r.id=d.report_id
 where d.status='sealed' and d.dossier_type='auditor_assurance' and b.status='settled' and r.status='published'
 and r.kind='auditor' and d.archive_hash=a.content_hash and d.archive_bytes=a.byte_size and a.lock_mode='COMPLIANCE'
 union all
 select d.tenant_id,d.engagement_id,d.report_id,d.id,d.dossier_type::text,d.sealed_at,
 a.id,a.build_id,a.provider,a.bucket,a.object_key,a.version_id,a.content_hash,a.byte_size,a.retain_until,a.encryption,'pramaan',d.proof_seal_hash,b.source_version_id,b.pdf_version_id,r.library_version
 from public.pramaan_dossiers d join public.pramaan_technical_builds b on b.tenant_id=d.tenant_id and b.dossier_id=d.id
 join public.pramaan_technical_archives a on a.tenant_id=d.tenant_id and a.build_id=b.id
 join public.reports r on r.tenant_id=d.tenant_id and r.id=d.report_id
 where d.status='sealed' and d.dossier_type='technical_register' and b.status='settled' and r.status='published'
 and r.kind='technical' and d.archive_hash=a.content_hash and d.archive_bytes=a.byte_size and a.lock_mode='COMPLIANCE';
revoke all on controller_security.full164_components from public,anon,authenticated,service_role,statutory_proof_writer;

create function controller_security.full164_source(t uuid,board_report uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare board record;auditor record;technical record;plan public.remediation_plans;batch public.execution_batches;
 request public.board_report_requests;eng public.engagements;proof public.approval_proof_archives;version public.approval_proof_versions;
 prepared jsonb;components jsonb:='[]'::jsonb;plans jsonb:='[]'::jsonb;proofs jsonb:='[]'::jsonb;findings jsonb;evidence record;
 source jsonb;text_source text;component_ids uuid[]:='{}';cutoff bigint;chain jsonb;entry record;payload text;previous text:=null;last_seq bigint:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('axiom.full-closure.snapshot',164));
 lock table public.findings,public.finding_evidence,public.evidence,public.evidence_object_versions,public.remediation_plans,public.remediation_actions,public.execution_batches,public.verification_results,public.plan_reconciliations,public.reports,public.pramaan_dossiers,public.approval_proof_archives in share mode;
 -- Board/auditor request status is a historical draft projection; their
 -- actual publication and provider custody are required by full164_components.
 -- Bound complete populations; never LIMIT a proof set and call it complete.
 select * into request from public.board_report_requests where tenant_id=t and report_id=board_report and status in ('drafted','reviewed','released');
 select * into eng from public.engagements where tenant_id=t and id=request.engagement_id;
 if request.id is null or eng.id is null or eng.status='cancelled' then raise exception 'released_board_source_required' using errcode='23514';end if;
 select * into board from controller_security.full164_components where tenant_id=t and report_id=board_report and kind='board_executive' order by sealed_at desc,dossier_id limit 1;
 select c.* into auditor from controller_security.full164_components c join public.statutory_report_requests q on q.tenant_id=c.tenant_id and q.report_id=c.report_id
 where c.tenant_id=t and c.engagement_id=eng.id and c.kind='auditor_assurance' and q.status in ('drafted','reviewed','released')
 and q.assessment_run_id=request.assessment_run_id and q.library_version=request.library_version and q.library_digest=request.library_digest
 and q.assessment_result_digest=request.assessment_result_digest order by c.sealed_at desc,c.dossier_id limit 1;
 if board.id is null or auditor.id is null or board.library_version<>eng.library_version or auditor.library_version<>eng.library_version then raise exception 'sealed_assessment_sources_required' using errcode='23514';end if;
 components:=jsonb_build_array(to_jsonb(board),to_jsonb(auditor));
 if not exists(select 1 from public.findings where tenant_id=t and engagement_id=eng.id)
 or exists(select 1 from public.findings where tenant_id=t and engagement_id=eng.id and status<>'closed')
 then raise exception 'all_recorded_findings_must_be_closed' using errcode='23514';end if;
 if (select count(*) from public.findings where tenant_id=t and engagement_id=eng.id)>500
 or (select count(*) from public.remediation_plans where tenant_id=t and engagement_id=eng.id)>50
 then raise exception 'closure_population_too_large' using errcode='54000';end if;
 if exists(select 1 from public.findings f where f.tenant_id=t and f.engagement_id=eng.id and (f.score<100 or f.risk_points>0) and not exists(
 select 1 from public.remediation_actions a join public.remediation_plans p on p.tenant_id=a.tenant_id and p.id=a.plan_id where a.tenant_id=t and p.engagement_id=eng.id and p.status<>'cancelled' and f.id=any(a.closes_finding_ids)))
 then raise exception 'gap_finding_action_link_required' using errcode='23514';end if;
 if exists(select 1 from public.remediation_actions a join public.remediation_plans p on p.tenant_id=a.tenant_id and p.id=a.plan_id cross join lateral unnest(a.closes_finding_ids) linked(finding_id)
 where a.tenant_id=t and p.engagement_id=eng.id and p.status<>'cancelled' and not exists(select 1 from public.findings f where f.tenant_id=t and f.engagement_id=eng.id and f.id=linked.finding_id))
 then raise exception 'closing_finding_scope_mismatch' using errcode='23514';end if;
 select jsonb_agg(to_jsonb(f)||jsonb_build_object('closing_actions',coalesce((select jsonb_agg(jsonb_build_object('action_id',a.id,'plan_id',a.plan_id,'batch_id',a.execution_batch_id) order by a.id) from public.remediation_actions a join public.remediation_plans p on p.tenant_id=a.tenant_id and p.id=a.plan_id where a.tenant_id=t and p.engagement_id=eng.id and p.status<>'cancelled' and f.id=any(a.closes_finding_ids)),'[]'::jsonb)) order by f.id) into findings from public.findings f where f.tenant_id=t and f.engagement_id=eng.id;
 -- Every recorded gap needs linked, actually retained evidence. Metadata and
 -- storage_uri strings alone have no standing here.
 if exists(select 1 from public.findings f where f.tenant_id=t and f.engagement_id=eng.id and not exists(
 select 1 from public.finding_evidence x join public.evidence_object_versions v on v.tenant_id=x.tenant_id and v.evidence_id=x.evidence_id
 join public.evidence e on e.tenant_id=x.tenant_id and e.id=x.evidence_id
 where x.tenant_id=t and x.finding_id=f.id and x.link_type='demonstrates' and e.engagement_id=eng.id and v.content_hash=e.content_hash and v.lock_mode='COMPLIANCE'))
 then raise exception 'retained_finding_evidence_required' using errcode='23514';end if;
 for evidence in select distinct v.*,e.collected_by_agent from public.finding_evidence x join public.findings f on f.tenant_id=x.tenant_id and f.id=x.finding_id
 join public.evidence e on e.tenant_id=x.tenant_id and e.id=x.evidence_id
 join public.evidence_object_versions v on v.tenant_id=e.tenant_id and v.evidence_id=e.id
 where x.tenant_id=t and f.engagement_id=eng.id and x.link_type='demonstrates' and e.engagement_id=eng.id and v.content_hash=e.content_hash and v.lock_mode='COMPLIANCE' order by v.id loop
 components:=components||jsonb_build_array(to_jsonb(evidence)||jsonb_build_object('kind','evidence','operation_id',evidence.ingestion_id,'engagement_id',eng.id));
 end loop;
 if exists(select 1 from public.remediation_plans p join public.execution_batches b on b.tenant_id=p.tenant_id and b.plan_id=p.id where p.tenant_id=t and p.engagement_id=eng.id and p.status='cancelled') then raise exception 'cancelled_execution_scope_requires_review' using errcode='23514';end if;
 if not exists(select 1 from public.remediation_plans where tenant_id=t and engagement_id=eng.id and status<>'cancelled')
 or exists(select 1 from public.remediation_plans where tenant_id=t and engagement_id=eng.id and status not in ('completed','cancelled')) then raise exception 'completed_plans_required' using errcode='23514';end if;
 for plan in select * from public.remediation_plans where tenant_id=t and engagement_id=eng.id and status<>'cancelled' order by id loop
 if plan.library_version<>eng.library_version or not exists(select 1 from public.remediation_actions where tenant_id=t and plan_id=plan.id)
 or exists(select 1 from public.remediation_actions a where a.tenant_id=t and a.plan_id=plan.id and (a.final_outcome is distinct from 'succeeded' or a.execution_batch_id is null or a.verification_status::text is distinct from 'succeeded' or not exists(
 select 1 from public.verification_results v where v.tenant_id=t and v.id=a.latest_verification_result_id and v.action_id=a.id and v.batch_id=a.execution_batch_id and v.outcome='passed' and jsonb_array_length(v.checks)>0 and exists(select 1 from public.audit_ledger l where l.tenant_id=t and l.action_type='verification.passed' and l.target_ref=a.id::text and l.result='success' and l.detail->>'verification_result_id'=v.id::text))))
 then raise exception 'successful_verified_actions_required' using errcode='23514';end if;
 select c.* into technical from controller_security.full164_components c join public.technical_report_requests q on q.tenant_id=c.tenant_id and q.report_id=c.report_id
 join public.technical_request_sources s on s.tenant_id=q.tenant_id and s.request_id=q.id
 where c.tenant_id=t and c.kind='technical_register' and c.engagement_id=eng.id and q.plan_id=plan.id and q.status='released'
 and c.library_version=eng.library_version and s.source_text::jsonb#>>'{plan,status}'='completed'
 and s.source_text::jsonb#>>'{plan,version}'=plan.version::text order by c.sealed_at desc,c.dossier_id limit 1;
 if technical.id is null then raise exception 'sealed_completed_plan_report_required' using errcode='23514';end if;
 components:=components||jsonb_build_array(to_jsonb(technical));plans:=plans||jsonb_build_array(to_jsonb(plan));
 for batch in select * from public.execution_batches where tenant_id=t and plan_id=plan.id order by id loop
 if batch.status<>'completed' or batch.finished_at is null then raise exception 'successful_completed_batches_required' using errcode='23514';end if;
 select * into proof from public.approval_proof_archives where tenant_id=t and batch_id=batch.id and status='released';
 select * into version from public.approval_proof_versions where tenant_id=t and archive_id=proof.id;
 if proof.id is null or version.id is null or proof.source_sha256<>version.content_hash or proof.source_bytes<>version.byte_size then raise exception 'released_approval_proof_required' using errcode='23514';end if;
 prepared:=public.prepare_approval_proof_source(t,batch.approval_token_id);
 if prepared?'error' or prepared->>'sourceSha256' is distinct from proof.source_sha256 or prepared->>'sourceText' is distinct from proof.source_text then raise exception 'reconciliation_proof_changed' using errcode='23514';end if;
 if not exists(select 1 from public.audit_ledger where tenant_id=t and action_type='approval.archive.released' and target_ref=proof.id::text and actor_type='human' and actor_id=proof.released_by::text and result='success' and detail->>'source_sha256'=proof.source_sha256 and detail->>'version_id'=version.version_id)
 then raise exception 'approval_release_receipt_required' using errcode='23514';end if;
 proofs:=proofs||jsonb_build_array(jsonb_build_object('archive_id',proof.id,'plan_id',plan.id,'batch_id',batch.id,'source_sha256',proof.source_sha256,'reconciliation',proof.source_text::jsonb->'reconciliation'));
 components:=components||jsonb_build_array(to_jsonb(version)||jsonb_build_object('kind','approval_proof','operation_id',proof.id,'engagement_id',eng.id,'collected_by_agent','approval-proof-archive'));
 end loop;
 end loop;
 if jsonb_array_length(proofs)=0 or jsonb_array_length(components)>128 or (select sum((v->>'byte_size')::bigint) from jsonb_array_elements(components)v)>50331648 then raise exception 'complete_closure_sources_exceed_bounds' using errcode='54000';end if;
 select jsonb_agg(v||jsonb_build_object('provider_engagement_id',case when v->>'kind'='approval_proof' then 'null'::jsonb else v->'engagement_id' end,'legal_hold',coalesce(v->'legal_hold','false'::jsonb)) order by n) into components from jsonb_array_elements(components) with ordinality x(v,n);
 if (select count(distinct v->>'id') from jsonb_array_elements(components)v)<>jsonb_array_length(components) then raise exception 'duplicate_closure_component' using errcode='23514';end if;
 -- Each sealed source must have a genuine founder seal receipt, not only a
 -- mutable status or an injected historical dossier row.
 for entry in select value as v from jsonb_array_elements(components) where value->>'kind' in ('board_executive','auditor_assurance','technical_register') loop
 if not exists(select 1 from public.audit_ledger where tenant_id=t and action_type='closure.pramaan.sealed' and target_ref=entry.v->>'dossier_id' and result='success' and actor_type='human' and detail->>'archive_sha256'=entry.v->>'content_hash' and detail->>'archive_version_id'=entry.v->>'version_id' and detail->>'proof_seal_hash'=entry.v->>'proof_seal_hash') then raise exception 'component_seal_receipt_required' using errcode='23514';end if;
 end loop;
 select max(sequence_no) into cutoff from public.audit_ledger where tenant_id=t and (
 (action_type='closure.pramaan.sealed' and target_ref in(select value->>'dossier_id' from jsonb_array_elements(components) where value?'dossier_id'))
 or (action_type='approval.archive.released' and target_ref in(select value->>'archive_id' from jsonb_array_elements(proofs))));
 if cutoff is null or cutoff>5000 then raise exception 'bounded_ledger_prefix_required' using errcode='54000';end if;
 chain:='[]'::jsonb;
 for entry in select * from public.audit_ledger where tenant_id=t and sequence_no<=cutoff order by sequence_no loop
 payload:=concat_ws('|',entry.sequence_no::text,entry.correlation_id::text,entry.actor_type::text,entry.actor_id,coalesce(entry.agent_version,''),coalesce(entry.model_id,''),coalesce(entry.prompt_hash,''),entry.action_type::text,coalesce(entry.target_ref,''),coalesce(entry.input_hash,''),coalesce(entry.output_hash,''),coalesce(entry.approval_token_id::text,''),coalesce(entry.approver_id::text,''),coalesce(entry.pre_state_ref,''),coalesce(entry.post_state_ref,''),entry.result::text,entry.occurred_at::text,coalesce(entry.prev_entry_hash,''),coalesce(entry.detail::text,'{}'));
 if entry.sequence_no<>last_seq+1 or entry.prev_entry_hash is distinct from previous or entry.entry_hash<>encode(sha256(convert_to(payload,'UTF8')),'hex') then raise exception 'ledger_chain_invalid' using errcode='23514';end if;
 chain:=chain||jsonb_build_array(jsonb_build_object('sequence_no',entry.sequence_no::text,'payload_text',payload,'entry_hash',entry.entry_hash,'previous_hash',entry.prev_entry_hash));previous:=entry.entry_hash;last_seq:=entry.sequence_no;
 end loop;
 source:=jsonb_build_object('schema_version',1,'kind','full_closure_source','tenant_id',t,'engagement_id',eng.id,'board_report_id',board_report,'assessment_run_id',request.assessment_run_id,'library_version',eng.library_version,'findings',findings,'plans',plans,'components',components,'reconciliations',proofs,'ledger_chain',chain,'ledger_head',previous,'as_of_sequence',cutoff::text,'statutory_completeness_asserted',false,'independent_audit_asserted',false);
 text_source:=source::text;if octet_length(text_source)>8388608 then raise exception 'closure_source_too_large' using errcode='54000';end if;
 return jsonb_build_object('sourceText',text_source,'sourceSha256',encode(sha256(convert_to(text_source,'UTF8')),'hex'));
end $$;
revoke all on function controller_security.full164_source(uuid,uuid) from public,anon,authenticated,service_role,statutory_proof_writer;
create function public.read_full_closure_source(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) and not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in ('owner','admin')) then raise exception 'manager authority required' using errcode='42501';end if;
 return controller_security.full164_source(p_tenant_id,p_report_id);
end $$;
revoke all on function public.read_full_closure_source(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_full_closure_source(uuid,uuid,uuid) to service_role,statutory_proof_writer;

create table public.pramaan_full_builds (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 dossier_id uuid not null unique,
 report_id uuid not null,
 source_text text not null check(octet_length(source_text) between 2 and 8388608),
 source_sha256 text not null check(source_sha256=encode(sha256(convert_to(source_text,'UTF8')),'hex')),
 operation_key uuid not null,
 requested_by uuid not null references public.users(id) on delete restrict,
 request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
 retain_until timestamptz not null,
 correlation_id uuid not null,
 status text not null default 'pending' check(status in ('pending','settled')),
 last_error_code text,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 settled_at timestamptz,
 unique(tenant_id,id), unique(tenant_id,id,dossier_id), unique(tenant_id,dossier_id), unique(tenant_id,operation_key),
 foreign key(tenant_id,dossier_id) references public.pramaan_dossiers(tenant_id,id) on delete restrict,
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 check((status='pending' and settled_at is null) or (status='settled' and settled_at is not null))
);
create table public.pramaan_full_archives (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 dossier_id uuid not null,
 build_id uuid not null,
 provider text not null check(provider in ('s3','s3-compatible')),
 bucket text not null,
 object_key text not null,
 version_id text not null check(length(version_id) between 1 and 1024 and btrim(version_id)<>'' and version_id<>'null'),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 byte_size bigint not null check(byte_size between 1 and 67108864),
 retain_until timestamptz not null,
 readback_at timestamptz not null,
 lock_mode text not null check(lock_mode='COMPLIANCE'),
 legal_hold boolean not null check(legal_hold=false),
 encryption text not null check(encryption in ('AES256','aws:kms')),
 receipt jsonb not null,
 verified_by uuid not null references public.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id), unique(tenant_id,dossier_id), unique(tenant_id,build_id),
 unique(provider,bucket,object_key,version_id),
 foreign key(tenant_id,dossier_id) references public.pramaan_dossiers(tenant_id,id) on delete restrict,
 foreign key(tenant_id,build_id,dossier_id) references public.pramaan_full_builds(tenant_id,id,dossier_id) on delete restrict
);
alter table public.pramaan_full_builds enable row level security;
alter table public.pramaan_full_archives enable row level security;
revoke all on public.pramaan_full_builds,public.pramaan_full_archives from public,anon,authenticated,service_role;
grant select on public.pramaan_full_builds,public.pramaan_full_archives to service_role;
create policy pramaan_full_build_service_read on public.pramaan_full_builds for select to service_role using(true);
create policy pramaan_full_archive_service_read on public.pramaan_full_archives for select to service_role using(true);
create trigger pramaan_full_build_immutable before update or delete on public.pramaan_full_builds
 for each row execute function public.pack_build_immutable();
create trigger pramaan_full_archive_immutable before update or delete on public.pramaan_full_archives
 for each row execute function public.evidence_receipt_immutable();



create table public.pramaan_full_reviews(
 tenant_id uuid not null,dossier_id uuid primary key,reviewed_by uuid not null references public.users(id),
 archive_sha256 text not null,archive_version_id text not null,note text not null check(length(btrim(note)) between 1 and 2000),
 reviewed_at timestamptz not null default clock_timestamp(),foreign key(tenant_id,dossier_id) references public.pramaan_dossiers(tenant_id,id)
);
create table public.pramaan_full_releases(
 tenant_id uuid not null,dossier_id uuid primary key,released_by uuid not null references public.users(id),
 archive_sha256 text not null,archive_version_id text not null,released_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,dossier_id) references public.pramaan_dossiers(tenant_id,id)
);
alter table public.pramaan_full_reviews enable row level security;alter table public.pramaan_full_releases enable row level security;
revoke all on public.pramaan_full_reviews,public.pramaan_full_releases from public,anon,authenticated,service_role;
grant select on public.pramaan_full_reviews,public.pramaan_full_releases to service_role;
create policy full_reviews_service_read on public.pramaan_full_reviews for select to service_role using(true);
create policy full_releases_service_read on public.pramaan_full_releases for select to service_role using(true);
create trigger full_reviews_immutable before update or delete or truncate on public.pramaan_full_reviews for each statement execute function public.evidence_receipt_immutable();
create trigger full_releases_immutable before update or delete or truncate on public.pramaan_full_releases for each statement execute function public.evidence_receipt_immutable();
create function controller_security.full164_merkle(source_hash text,components jsonb) returns text
language plpgsql immutable set search_path='' as $$declare nodes bytea[];next_nodes bytea[];v jsonb;i integer;begin
 nodes:=array[sha256(decode('00','hex')||decode(source_hash,'hex'))];
 for v in select value from jsonb_array_elements(components) loop nodes:=array_append(nodes,sha256(decode('00','hex')||decode(v->>'content_hash','hex')));end loop;
 while cardinality(nodes)>1 loop next_nodes:='{}';i:=1;while i<=cardinality(nodes) loop next_nodes:=array_append(next_nodes,sha256(decode('01','hex')||nodes[i]||coalesce(nodes[i+1],nodes[i])));i:=i+2;end loop;nodes:=next_nodes;end loop;
 return encode(nodes[1],'hex');end $$;
revoke all on function controller_security.full164_merkle(text,jsonb) from public,anon,authenticated,service_role,statutory_proof_writer;
create function public.begin_full_pramaan(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,p_operation_key uuid,p_title text,p_source_text text,p_request jsonb,p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare source jsonb;b public.pramaan_full_builds;d uuid;root text;proof text;begin
 source:=public.read_full_closure_source(p_tenant_id,p_actor_id,p_report_id);
 if p_operation_key is null or p_correlation_id is null or p_title is null or length(btrim(p_title)) not between 1 and 300
 or p_request is null or jsonb_typeof(p_request)<>'object' or p_request-array['provider','bucket','source_sha256','manifest_sha256','archive_sha256','archive_bytes','object_key','merkle_root']<>'{}'::jsonb
 or not p_request?&array['provider','bucket','source_sha256','manifest_sha256','archive_sha256','archive_bytes','object_key','merkle_root']
 or p_request->>'provider' not in ('s3','s3-compatible') or (p_request->>'bucket')!~'^[a-zA-Z0-9][a-zA-Z0-9._-]{2,254}$'
 or p_request->>'source_sha256' !~'^[a-f0-9]{64}$' or p_request->>'manifest_sha256' !~'^[a-f0-9]{64}$' or p_request->>'archive_sha256' !~'^[a-f0-9]{64}$'
 or p_request->>'archive_bytes' !~'^[1-9][0-9]{0,7}$' or (p_request->>'archive_bytes')::bigint>67108864
 then return jsonb_build_object('error','invalid_request');end if;
 if source->>'sourceText' is distinct from p_source_text or source->>'sourceSha256' is distinct from p_request->>'source_sha256' then return jsonb_build_object('error','closure_source_changed');end if;
 root:=controller_security.full164_merkle(source->>'sourceSha256',p_source_text::jsonb->'components');
 if root is distinct from p_request->>'merkle_root' or p_request->>'object_key' is distinct from 'tenants/'||p_tenant_id::text||'/pramaan/full/'||p_report_id::text||'/'||p_operation_key::text||'/'||(p_request->>'archive_sha256') then return jsonb_build_object('error','invalid_request');end if;
 select * into b from public.pramaan_full_builds where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then if b.report_id<>p_report_id or b.request<>p_request or b.source_text<>p_source_text or b.requested_by<>p_actor_id then return jsonb_build_object('error','idempotency_conflict');end if;return jsonb_build_object('dossierId',b.dossier_id,'buildId',b.id,'status',b.status,'replayed',true);end if;
 proof:=encode(sha256(convert_to('pramaan-proof-v1:'||(p_request->>'manifest_sha256')||':'||(p_request->>'archive_sha256'),'UTF8')),'hex');
 insert into public.pramaan_dossiers(tenant_id,engagement_id,report_id,dossier_type,title,status,merkle_root,manifest_hash,archive_hash,archive_bytes,proof_seal_hash,metadata)
 values(p_tenant_id,(p_source_text::jsonb->>'engagement_id')::uuid,p_report_id,'full_closure',btrim(p_title),'draft',root,p_request->>'manifest_sha256',p_request->>'archive_sha256',(p_request->>'archive_bytes')::bigint,proof,jsonb_build_object('source_kind','released_complete_engagement_closure_v1','source_sha256',p_request->>'source_sha256')) returning id into d;
 insert into public.pramaan_full_builds(tenant_id,dossier_id,report_id,source_text,source_sha256,operation_key,requested_by,request,retain_until,correlation_id)
 values(p_tenant_id,d,p_report_id,p_source_text,p_request->>'source_sha256',p_operation_key,p_actor_id,p_request,date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id) returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'closure.pramaan.drafted',d::text,null,null,null,null,null,null,'success',jsonb_build_object('kind','full_closure','source_sha256',b.source_sha256,'archive_sha256',p_request->>'archive_sha256','build_id',b.id));
 return jsonb_build_object('dossierId',d,'buildId',b.id,'status','pending','replayed',false);
end $$;

create function public.settle_full_pramaan(
 p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,p_receipt jsonb,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.pramaan_full_builds; d public.pramaan_dossiers; a public.pramaan_full_archives;
 v_until timestamptz;v_readback timestamptz; v_field text;
begin
 if p_correlation_id is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
   or octet_length(p_receipt::text)>16384 then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into b from public.pramaan_full_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) and (b.requested_by is distinct from p_actor_id or not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in ('owner','admin')))
   then return jsonb_build_object('error','manager_authority_required'); end if;
 select * into d from public.pramaan_dossiers where tenant_id=p_tenant_id and id=b.dossier_id for update;
 select * into a from public.pramaan_full_archives where tenant_id=p_tenant_id and build_id=b.id;
 if found then
   if a.receipt is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
   return jsonb_build_object('dossierId',d.id,'buildId',b.id,'status','settled','replayed',true);
 end if;
 if b.status<>'pending' or d.status<>'draft' then return jsonb_build_object('error','not_draft'); end if;
 foreach v_field in array array['provider','bucket','object_key','version_id','content_hash','tenant_id',
   'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','encryption','operation_id','correlation_id'] loop
   if jsonb_typeof(p_receipt->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_receipt'); end if;
 end loop;
 if not(p_receipt ?& array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id',
   'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold',
   'encryption','operation_id','correlation_id'])
   or (p_receipt-array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id',
   'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold',
   'encryption','operation_id','correlation_id'])<>'{}'::jsonb
   or p_receipt->>'provider' is distinct from b.request->>'provider'
   or p_receipt->>'bucket' is distinct from b.request->>'bucket'
   or p_receipt->>'object_key' is distinct from b.request->>'object_key'
   or p_receipt->>'content_hash' is distinct from b.request->>'archive_sha256'
   or p_receipt->'byte_size' is distinct from b.request->'archive_bytes'
   or p_receipt->>'tenant_id' is distinct from p_tenant_id::text
   or p_receipt->>'engagement_id' is distinct from d.engagement_id::text
   or p_receipt->>'collected_by_agent' is distinct from 'pramaan'
   or p_receipt->>'operation_id' is distinct from b.id::text
   or p_receipt->>'correlation_id' is distinct from b.correlation_id::text
   or p_receipt->'verified' is distinct from 'true'::jsonb
   or p_receipt->'legal_hold' is distinct from 'false'::jsonb
   or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE'
   or p_receipt->>'encryption' not in ('AES256','aws:kms')
   or length(coalesce(p_receipt->>'version_id','')) not between 1 and 1024
   or btrim(p_receipt->>'version_id')='' or p_receipt->>'version_id'='null'
   then return jsonb_build_object('error','receipt_mismatch'); end if;
 begin v_until:=(p_receipt->>'retain_until')::timestamptz;
   v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','invalid_receipt'); end;
 if v_until is null or not isfinite(v_until) or v_until<b.retain_until
   or v_readback is null or not isfinite(v_readback)
   or v_readback<clock_timestamp()-interval '5 minutes'
   or v_readback>clock_timestamp()+interval '5 minutes'
   then return jsonb_build_object('error','receipt_mismatch'); end if;
 insert into public.pramaan_full_archives(tenant_id,dossier_id,build_id,provider,bucket,object_key,
   version_id,content_hash,byte_size,retain_until,readback_at,lock_mode,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,d.id,b.id,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',
   p_receipt->>'version_id',p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,
   v_until,v_readback,'COMPLIANCE',false,p_receipt->>'encryption',p_receipt,p_actor_id);
 update public.pramaan_full_builds set status='settled',settled_at=clock_timestamp(),
   last_error_code=null,updated_at=clock_timestamp() where id=b.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'closure.pramaan.archive_settled'::public.ledger_action_type,d.id::text,null,null,null,null,null,null,
   'success',jsonb_build_object('build_id',b.id,'version_id',p_receipt->>'version_id',
     'archive_sha256',p_receipt->>'content_hash'));
 return jsonb_build_object('dossierId',d.id,'buildId',b.id,'status','settled','replayed',false);
end $$;

create function public.note_full_pramaan_failure(
 p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,p_error_code text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.pramaan_full_builds;
begin
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$'
   then return jsonb_build_object('error','invalid_request'); end if;
 select * into b from public.pramaan_full_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) and (b.requested_by is distinct from p_actor_id or not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in ('owner','admin')))
   then return jsonb_build_object('error','manager_authority_required'); end if;
 if b.status='pending' and b.last_error_code is distinct from p_error_code then
   update public.pramaan_full_builds set last_error_code=p_error_code,
     updated_at=clock_timestamp() where id=b.id;
   perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
     'closure.pramaan.archive_pending'::public.ledger_action_type,b.dossier_id::text,null,null,null,null,null,null,
     'failure',jsonb_build_object('build_id',b.id,'error_code',p_error_code));
 end if;
 return jsonb_build_object('dossierId',b.dossier_id,'buildId',b.id,'status',b.status);
end $$;


create function public.review_full_pramaan(p_tenant_id uuid,p_actor_id uuid,p_dossier_id uuid,p_expected_archive text,p_expected_version text,p_note text,p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare d public.pramaan_dossiers;b public.pramaan_full_builds;a public.pramaan_full_archives;review public.pramaan_full_reviews;source jsonb;begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required');end if;
 select * into b from public.pramaan_full_builds where tenant_id=p_tenant_id and dossier_id=p_dossier_id for update;
 select * into d from public.pramaan_dossiers where tenant_id=p_tenant_id and id=p_dossier_id for update;
 select * into a from public.pramaan_full_archives where tenant_id=p_tenant_id and dossier_id=p_dossier_id;
 if b.id is null or a.id is null or b.status<>'settled' or a.build_id<>b.id or a.content_hash is distinct from p_expected_archive or a.version_id is distinct from p_expected_version or d.archive_hash<>a.content_hash then return jsonb_build_object('error','archive_unverified');end if;
 if b.requested_by=p_actor_id then return jsonb_build_object('error','independent_founder_review_required');end if;
 if p_correlation_id is null or p_note is null or length(btrim(p_note)) not between 1 and 2000 then return jsonb_build_object('error','invalid_request');end if;
 source:=controller_security.full164_source(p_tenant_id,b.report_id);if source->>'sourceSha256' is distinct from b.source_sha256 then return jsonb_build_object('error','closure_source_changed');end if;
 select * into review from public.pramaan_full_reviews where dossier_id=d.id;
 if found then if review.archive_sha256<>p_expected_archive or review.archive_version_id<>p_expected_version or review.reviewed_by<>p_actor_id or review.note<>btrim(p_note) then return jsonb_build_object('error','review_conflict');end if;return jsonb_build_object('dossierId',d.id,'status','approved','replayed',true);end if;
 if d.status<>'draft' then return jsonb_build_object('error','not_draft');end if;
 insert into public.pramaan_full_reviews values(p_tenant_id,d.id,p_actor_id,p_expected_archive,p_expected_version,btrim(p_note));
 update public.pramaan_dossiers set status='approved',updated_at=clock_timestamp() where id=d.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'closure.pramaan.reviewed',d.id::text,null,null,null,null,null,null,'success',jsonb_build_object('archive_sha256',a.content_hash,'archive_version_id',a.version_id,'note_sha256',encode(sha256(convert_to(btrim(p_note),'UTF8')),'hex')));
 return jsonb_build_object('dossierId',d.id,'status','approved','replayed',false);
end $$;
create function public.seal_full_pramaan(p_tenant_id uuid,p_actor_id uuid,p_dossier_id uuid,p_expected_proof_seal text,p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare d public.pramaan_dossiers;b public.pramaan_full_builds;a public.pramaan_full_archives;review public.pramaan_full_reviews;source jsonb;begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required');end if;
 select * into b from public.pramaan_full_builds where tenant_id=p_tenant_id and dossier_id=p_dossier_id for update;
 select * into d from public.pramaan_dossiers where tenant_id=p_tenant_id and id=p_dossier_id for update;
 select * into a from public.pramaan_full_archives where tenant_id=p_tenant_id and dossier_id=p_dossier_id;
 select * into review from public.pramaan_full_reviews where tenant_id=p_tenant_id and dossier_id=p_dossier_id;
 if b.id is null or a.id is null or review.dossier_id is null or not public.report_founder_allowed(p_tenant_id,review.reviewed_by) or b.status<>'settled' or a.content_hash<>review.archive_sha256 or a.version_id<>review.archive_version_id then return jsonb_build_object('error','reviewed_retained_archive_required');end if;
 if p_correlation_id is null or d.proof_seal_hash is distinct from p_expected_proof_seal then return jsonb_build_object('error','proof_seal_mismatch');end if;
 source:=controller_security.full164_source(p_tenant_id,b.report_id);if source->>'sourceSha256' is distinct from b.source_sha256 then return jsonb_build_object('error','closure_source_changed');end if;
 if d.status='sealed' then return jsonb_build_object('dossierId',d.id,'status','sealed','replayed',true);end if;
 if d.status<>'approved' then return jsonb_build_object('error','founder_review_required');end if;
 update public.pramaan_dossiers set status='sealed',sealed_at=clock_timestamp(),sealed_by=p_actor_id,updated_at=clock_timestamp() where id=d.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'closure.pramaan.sealed',d.id::text,null,null,null,null,null,null,'success',jsonb_build_object('kind','full_closure','archive_sha256',a.content_hash,'archive_version_id',a.version_id,'proof_seal_hash',d.proof_seal_hash));
 return jsonb_build_object('dossierId',d.id,'status','sealed','replayed',false);
end $$;
create function public.release_full_pramaan(p_tenant_id uuid,p_actor_id uuid,p_dossier_id uuid,p_expected_archive text,p_expected_version text,p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare d public.pramaan_dossiers;b public.pramaan_full_builds;a public.pramaan_full_archives;release public.pramaan_full_releases;source jsonb;begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required');end if;
 select * into b from public.pramaan_full_builds where tenant_id=p_tenant_id and dossier_id=p_dossier_id for update;
 select * into d from public.pramaan_dossiers where tenant_id=p_tenant_id and id=p_dossier_id for update;
 select * into a from public.pramaan_full_archives where tenant_id=p_tenant_id and dossier_id=p_dossier_id;
 if b.id is null or a.id is null or b.status<>'settled' or d.status<>'sealed' or a.content_hash is distinct from p_expected_archive or a.version_id is distinct from p_expected_version or p_correlation_id is null then return jsonb_build_object('error','sealed_retained_archive_required');end if;
 select * into release from public.pramaan_full_releases where dossier_id=d.id;
 if found then return jsonb_build_object('dossierId',d.id,'status','released','replayed',true);end if;
 source:=controller_security.full164_source(p_tenant_id,b.report_id);if source->>'sourceSha256' is distinct from b.source_sha256 then return jsonb_build_object('error','closure_source_changed');end if;
 insert into public.pramaan_full_releases(tenant_id,dossier_id,released_by,archive_sha256,archive_version_id) values(p_tenant_id,d.id,p_actor_id,a.content_hash,a.version_id);
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'closure.pramaan.released',d.id::text,null,null,null,null,null,null,'success',jsonb_build_object('archive_sha256',a.content_hash,'archive_version_id',a.version_id));
 return jsonb_build_object('dossierId',d.id,'status','released','replayed',false);
end $$;
revoke all on function public.begin_full_pramaan(uuid,uuid,uuid,uuid,text,text,jsonb,uuid),public.settle_full_pramaan(uuid,uuid,uuid,jsonb,uuid),public.note_full_pramaan_failure(uuid,uuid,uuid,text,uuid),public.review_full_pramaan(uuid,uuid,uuid,text,text,text,uuid),public.seal_full_pramaan(uuid,uuid,uuid,text,uuid),public.release_full_pramaan(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_full_pramaan(uuid,uuid,uuid,uuid,text,text,jsonb,uuid),public.settle_full_pramaan(uuid,uuid,uuid,jsonb,uuid),public.note_full_pramaan_failure(uuid,uuid,uuid,text,uuid),public.review_full_pramaan(uuid,uuid,uuid,text,text,text,uuid),public.seal_full_pramaan(uuid,uuid,uuid,text,uuid),public.release_full_pramaan(uuid,uuid,uuid,text,text,uuid) to statutory_proof_writer;
-- Sealed full-closure metadata is visible to ordinary readers only after the
-- separate founder release. Historical source-free full rows remain internal.
create function public.read_sealed_dossier_summaries(p_tenant_id uuid,p_actor_id uuid,p_limit integer,p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$declare rows_json jsonb;n bigint;begin
 if not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role<>'agent') then raise exception 'tenant report reader required' using errcode='42501';end if;
 if p_limit not between 1 and 100 or p_offset<0 then raise exception 'invalid summary page' using errcode='22023';end if;
 select count(*) into n from public.pramaan_dossiers d where d.tenant_id=p_tenant_id and d.status='sealed' and (d.dossier_type<>'full_closure' or exists(select 1 from public.pramaan_full_releases r where r.tenant_id=d.tenant_id and r.dossier_id=d.id and r.archive_sha256=d.archive_hash));
 select coalesce(jsonb_agg(to_jsonb(x) order by x.sealed_at desc,x.id),'[]'::jsonb) into rows_json from (select d.id,d.dossier_type,d.title,d.merkle_root,d.proof_seal_hash,d.sealed_at,d.created_at from public.pramaan_dossiers d where d.tenant_id=p_tenant_id and d.status='sealed' and (d.dossier_type<>'full_closure' or exists(select 1 from public.pramaan_full_releases r where r.tenant_id=d.tenant_id and r.dossier_id=d.id and r.archive_sha256=d.archive_hash)) order by d.sealed_at desc,d.id limit p_limit offset p_offset)x;
 return jsonb_build_object('rows',rows_json,'total',n);
end $$;
revoke all on function public.read_sealed_dossier_summaries(uuid,uuid,integer,integer) from public,anon,authenticated,statutory_proof_writer;
grant execute on function public.read_sealed_dossier_summaries(uuid,uuid,integer,integer) to service_role;

create trigger full_builds_no_truncate before truncate on public.pramaan_full_builds for each statement execute function public.evidence_receipt_immutable();
create trigger full_archives_no_truncate before truncate on public.pramaan_full_archives for each statement execute function public.evidence_receipt_immutable();
