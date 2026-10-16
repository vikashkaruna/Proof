-- Read-only human policy workflow context; no transition, role or credential changes.
create function public.read_local_custody_operator_context(
 p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_policy_id uuid default null,
 p_after_policy_id uuid default null,p_before_receipt_id bigint default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare member_role public.user_role;internal boolean;demo boolean;rows_json jsonb;history_json jsonb:='[]'::jsonb;next_policy uuid;next_history bigint;can_request boolean;request_modes jsonb;
begin
 if p_tenant_id is null or p_actor_id is null or p_session_id is null
  or (p_policy_id is null and p_before_receipt_id is not null)
  or (p_policy_id is not null and p_after_policy_id is not null)
  or p_before_receipt_id<=0 then raise exception 'custody context scope refused' using errcode='22023';end if;
 select m.role,u.is_axiom_internal,t.is_demo into member_role,internal,demo
 from public.tenant_users m join public.users u on u.id=m.user_id join public.tenants t on t.id=m.tenant_id
 where m.tenant_id=p_tenant_id and m.user_id=p_actor_id;
 if member_role is null or not (member_role='owner' or (internal and member_role in ('founder','axiom_analyst')))
  or not exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p_actor_id and (s.not_after is null or s.not_after>clock_timestamp()))
 then raise exception 'custody context authority refused' using errcode='42501';end if;
 request_modes:=case when member_role='owner' then case when demo then '["operator_managed","local_demo"]'::jsonb else '["operator_managed"]'::jsonb end when member_role='founder' and internal and demo then '["local_demo"]'::jsonb else '[]'::jsonb end;
 can_request:=jsonb_array_length(request_modes)>0;
 if p_policy_id is not null and not exists(select 1 from public.local_custody_policy_versions v where v.tenant_id=p_tenant_id and v.id=p_policy_id and controller_security.local143_reader(p_tenant_id,p_actor_id,v.policy_text::jsonb))
 then raise exception 'custody context unavailable' using errcode='42501';end if;
 with candidates as (
 select v.*,h.event_id,h.state,h.activation_epoch,h.review_due_at_ms
 from public.local_custody_policy_versions v join public.local_custody_policy_heads h on h.tenant_id=v.tenant_id and h.policy_id=v.id
 where v.tenant_id=p_tenant_id and (p_policy_id is null or v.id=p_policy_id)
 and (p_after_policy_id is null or v.id>p_after_policy_id)
 and controller_security.local143_reader(p_tenant_id,p_actor_id,v.policy_text::jsonb)
 order by v.id limit 21
 ), shown as (select * from candidates order by id limit 20)
 select coalesce((select jsonb_agg(jsonb_build_object('policyId',v.id,'policyText',v.policy_text,'policySha256',v.policy_sha256,'keyPolicySha256',v.key_policy_sha256,
 'head',jsonb_build_object('eventId',v.event_id,'state',v.state,'activationEpoch',v.activation_epoch,'reviewDueAt',v.review_due_at_ms),
 'reviewOverdue',v.review_due_at_ms<floor(extract(epoch from clock_timestamp())*1000),'actions',(select coalesce(jsonb_agg(action order by action),'[]'::jsonb) from unnest(array['approve','activate','revoke','review']) action where controller_security.local143_actor(p_tenant_id,p_actor_id,action,v.policy_text::jsonb)
 and ((action='approve' and v.state='requested') or (action='activate' and v.state='approved') or (action='review' and v.state='active') or (action='revoke' and v.state<>'revoked')))) order by v.id) from shown v),'[]'::jsonb),
 case when (select count(*) from candidates)>20 then (select id from shown order by id desc limit 1) else null end
 into rows_json,next_policy;
 if p_policy_id is not null then
  with candidates as (select e.* from public.local_custody_policy_events e where e.tenant_id=p_tenant_id and e.policy_id=p_policy_id and (p_before_receipt_id is null or e.receipt_id<p_before_receipt_id) order by e.receipt_id desc limit 21),
  shown as (select * from candidates order by receipt_id desc limit 20)
  select coalesce((select jsonb_agg(controller_security.local143_result(e,true) order by e.receipt_id desc) from public.local_custody_policy_events e join shown s on s.id=e.id and s.tenant_id=e.tenant_id),'[]'::jsonb),
   case when (select count(*) from candidates)>20 then (select receipt_id from shown order by receipt_id limit 1) else null end
  into history_json,next_history;
 end if;
 return jsonb_build_object('version',1,'tenantId',p_tenant_id,'actorId',p_actor_id,'isDemo',demo,'canRequest',can_request,'requestModes',request_modes,'selectedPolicyId',p_policy_id,
 'rows',rows_json,'nextCursor',next_policy,'history',history_json,'nextHistoryCursor',next_history::text);
end $$;
revoke all on function public.read_local_custody_operator_context(uuid,uuid,uuid,uuid,uuid,bigint) from public,anon,authenticated,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_local_custody_issuer;
grant execute on function public.read_local_custody_operator_context(uuid,uuid,uuid,uuid,uuid,bigint) to service_role;
