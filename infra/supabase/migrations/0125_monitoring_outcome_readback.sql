-- Read-only human member projection; no fire table grants or scheduler activation.
create function public.read_monitoring_outcomes(p_tenant_id uuid,p_schedule_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare sid uuid; fid uuid; proof jsonb; summaries jsonb:='[]'::jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.tenant_users u where u.tenant_id=p_tenant_id and u.user_id=auth.uid()
  and u.role::text in ('founder','axiom_analyst','owner','admin','approver','reviewer','viewer','partner'))
 then return jsonb_build_object('error','monitoring_read_refused');end if;
 if p_schedule_ids is null or coalesce(array_length(p_schedule_ids,1),0)>100
  or array_ndims(p_schedule_ids)>1 or exists(select 1 from unnest(p_schedule_ids) x where x is null or x='00000000-0000-0000-0000-000000000000'::uuid)
  or (select count(*) from unnest(p_schedule_ids))<>(select count(distinct x) from unnest(p_schedule_ids) x)
 then return jsonb_build_object('error','monitoring_read_refused');end if;
 foreach sid in array p_schedule_ids loop
  if not exists(select 1 from public.monitoring_schedules s where s.tenant_id=p_tenant_id and s.id=sid)
  then return jsonb_build_object('error','monitoring_read_refused');end if;
  select f.id into fid from public.monitoring_schedule_fires f where f.tenant_id=p_tenant_id and f.schedule_id=sid order by f.due_at desc,f.id desc limit 1;
  if fid is null then
   summaries:=summaries||jsonb_build_array(jsonb_build_object('scheduleId',sid,'state','never_recorded','fire',null));
  else
   proof:=controller_security.monitoring_fire_response(fid,true);
   if proof is null or proof ? 'error' then return jsonb_build_object('error','monitoring_proof_unavailable');end if;
   summaries:=summaries||jsonb_build_array(jsonb_build_object('scheduleId',sid,'state','retained','fire',
    proof-'tenantId'-'scheduleId'-'replayed'-'eventReceipts'-'cadence'));
  end if;
 end loop;
 return jsonb_build_object('tenantId',p_tenant_id,'schedules',summaries);
end $$;
revoke all on function public.read_monitoring_outcomes(uuid,uuid[]) from public,anon,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_monitoring_outcomes(uuid,uuid[]) to authenticated;
