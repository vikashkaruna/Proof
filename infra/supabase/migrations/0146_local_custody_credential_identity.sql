-- Identity-only PostgREST probe for protected145 local credential publication.
-- No arguments/selectors, inventory reads, issuance, keys, policy authority or
-- execution grants. PostgreSQL registry checks do not replace signature/expiry
-- verification by the configured PostgREST gateway.
create function public.read_local_custody_credential_identity() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c controller_security.local_custody_credentials;fresh controller_security.local_custody_credentials;
 i controller_security.local_custody_issuances;l public.audit_ledger;r jsonb;
begin
 c:=controller_security.local143_credential();
 select * into i from controller_security.local_custody_issuances where credential_id=c.id and tenant_id=c.tenant_id;
 select * into l from public.audit_ledger where tenant_id=c.tenant_id and id=i.receipt_id;
 if i.credential_id is null or l.id is null then raise exception 'local credential identity unavailable' using errcode='42501';end if;
 r:=controller_security.local145_request(i.request_text,i.request_sha256,'local-custody-credential-issue');
 if (r->>'credentialId')::uuid is distinct from c.id or (r->>'tenantId')::uuid is distinct from c.tenant_id
  or (r->>'workloadId')::uuid is distinct from c.workload_id or r->>'configurationSha256' is distinct from c.configuration_sha256
  or r->>'principalKind' is distinct from c.principal_kind or r->>'servicePrincipal' is distinct from c.service_principal
  or (r->>'operatorId')::uuid is distinct from c.operator_id or to_timestamp((r->>'expiresAt')::double precision) is distinct from c.expires_at
  or l.action_type::text is distinct from 'custody.local_credential_issued' or l.actor_type::text is distinct from 'system'
  or l.actor_id is distinct from 'axiom-local-custody-issuer' or l.target_ref is distinct from c.id::text
  or l.input_hash is distinct from i.request_sha256 or l.output_hash is distinct from r->>'policySha256'
 then raise exception 'local credential identity refused' using errcode='42501';end if;
 fresh:=controller_security.local143_credential();
 if fresh is distinct from c then raise exception 'local credential identity changed' using errcode='42501';end if;
 return jsonb_build_object('version',1,'credentialId',c.id,'tenantId',c.tenant_id,'workloadId',c.workload_id,
  'principalKind',c.principal_kind,'servicePrincipal',c.service_principal,'operatorId',c.operator_id,
  'configurationSha256',c.configuration_sha256,'issuanceSha256',i.request_sha256,'issuedAt',r->'issuedAt','expiresAt',r->'expiresAt');
end $$;
revoke all on function public.read_local_custody_credential_identity() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_issuer,axiom_local_custody_verifier;
grant execute on function public.read_local_custody_credential_identity() to axiom_local_custody_verifier;
