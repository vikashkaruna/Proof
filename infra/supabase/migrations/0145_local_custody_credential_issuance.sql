-- STAGED / UNEXECUTED. Protected deployment administration only, dispatch DEK
-- custody only. No tokens, keys, issuer startup, app mount or direct role grants.
-- PRECONDITION: a trusted administrator explicitly creates the safe NOLOGIN
-- axiom_local_custody_issuer role with ZERO members before first installation.
-- An independently reviewed external operator login may receive SET membership
-- afterward. Never give it to postgres, authenticator, application or SPIRE.
do $$begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_issuer'
   and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member where r.rolname='axiom_local_custody_issuer')
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid where r.rolname='axiom_local_custody_issuer')
 then raise exception 'explicit empty protected local issuer role required' using errcode='42501';end if;
end $$;
alter type public.ledger_action_type add value if not exists 'custody.local_credential_issued';
alter type public.ledger_action_type add value if not exists 'custody.local_credential_revoked';

create table controller_security.local_custody_issuances (
 credential_id uuid primary key references controller_security.local_custody_credentials(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 policy_id uuid not null,activation_event_id uuid not null,activation_epoch bigint not null check(activation_epoch>0),
 predecessor_id uuid unique references controller_security.local_custody_issuances(credential_id) on delete restrict,
 request_text text not null check(octet_length(request_text) between 2 and 16384),
 request_sha256 text not null unique check(request_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,policy_id) references public.local_custody_policy_versions(tenant_id,id) on delete restrict,
 foreign key(tenant_id,activation_event_id) references public.local_custody_policy_events(tenant_id,id) on delete restrict,
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict,
 unique(tenant_id,credential_id),unique(tenant_id,receipt_id)
);
create table controller_security.local_custody_revocations (
 credential_id uuid primary key references controller_security.local_custody_issuances(credential_id) on delete restrict,
 tenant_id uuid not null,request_text text not null check(octet_length(request_text) between 2 and 16384),
 request_sha256 text not null unique check(request_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,credential_id) references controller_security.local_custody_issuances(tenant_id,credential_id) on delete restrict,
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict,
 unique(tenant_id,receipt_id)
);
revoke all on controller_security.local_custody_issuances,controller_security.local_custody_revocations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_local_custody_issuer;
do $$declare t text;begin
 foreach t in array array['local_custody_issuances','local_custody_revocations'] loop
  execute format('create trigger local145_immutable before update or delete on controller_security.%I for each row execute function public.evidence_receipt_immutable()',t);
  execute format('create trigger local145_no_truncate before truncate on controller_security.%I for each statement execute function public.evidence_receipt_immutable()',t);
 end loop;
end $$;

create function controller_security.local145_require_issuer() returns void language plpgsql volatile security definer set search_path='' as $$
declare issuer oid;login pg_catalog.pg_roles;
begin
 -- SECURITY DEFINER changes current_user. Require the actual external session
 -- login AND its live SET capability; an earlier SET ROLE survives role revocation.
 select oid into issuer from pg_catalog.pg_roles where rolname='axiom_local_custody_issuer'
  and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls);
 select * into login from pg_catalog.pg_roles where rolname=session_user;
 if current_setting('role',true) is distinct from 'axiom_local_custody_issuer'
  or issuer is null or login.oid is null or not login.rolcanlogin
  or login.rolsuper or login.rolcreatedb or login.rolcreaterole or login.rolreplication or login.rolbypassrls
  or login.rolname in ('postgres','supabase_admin','authenticator','anon','authenticated','service_role','human_action_writer','agent_ledger_writer','ledger_writer','axiom_assessment_controller','axiom_prativedan_controller','axiom_local_custody_verifier','axiom_controller_issuer')
  or not pg_catalog.pg_has_role(login.oid,issuer,'SET')
  or exists(select 1 from pg_catalog.pg_auth_members where member=issuer)
  or exists(select 1 from pg_catalog.pg_auth_members where roleid=issuer and (admin_option or inherit_option or not set_option))
 then raise exception 'protected live local issuer session required' using errcode='42501';end if;
 -- Follow actual SET edges through any intermediate LOGIN/NOLOGIN roles. A safe
 -- direct operator is not a shield for an application -> operator -> issuer path.
 -- UNION deduplicates role OIDs, so accidental cycles cannot expand unboundedly.
 if exists(
  with recursive prohibited(oid) as (
   select oid from pg_catalog.pg_roles where rolname in
    ('postgres','supabase_admin','authenticator','anon','authenticated','service_role','human_action_writer','agent_ledger_writer','ledger_writer','axiom_assessment_controller','axiom_prativedan_controller','axiom_local_custody_verifier','axiom_controller_issuer')
    or (oid<>issuer and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
   union
   select membership.roleid from pg_catalog.pg_auth_members membership join prohibited prior on prior.oid=membership.member where membership.set_option
  ) select 1 from prohibited where oid=issuer
 ) then raise exception 'prohibited transitive local issuer role path' using errcode='42501';end if;
end $$;

create function controller_security.local145_request(p_text text,p_sha text,p_purpose text) returns jsonb language plpgsql immutable set search_path='' as $$
declare r jsonb;keys text[];k text;v numeric;
begin
 if p_text is null or octet_length(p_text) not between 2 and 16384 or p_sha is null or p_sha !~ '^[a-f0-9]{64}$'
  or encode(sha256(convert_to(p_text,'UTF8')),'hex') is distinct from p_sha then raise exception 'local issuer request refused' using errcode='22023';end if;
 r:=p_text::jsonb;
 if jsonb_typeof(r) is distinct from 'object' or controller_security.canonical_questionnaire_json(r) is distinct from p_text
  or r->'version' is distinct from '1'::jsonb or r->>'purpose' is distinct from p_purpose then raise exception 'canonical local issuer request required' using errcode='22023';end if;
 keys:=array['version','purpose','credentialId','tenantId','reason'];
 if p_purpose='local-custody-credential-issue' then
  keys:=keys||array['policyId','policySha256','activationEventId','activationEpoch','configurationSha256','workloadId','principalKind','servicePrincipal','operatorId','predecessorId','issuedAt','expiresAt'];
 elsif p_purpose='local-custody-credential-revoke' then keys:=keys||array['issuanceSha256'];
 else raise exception 'local issuer purpose refused' using errcode='22023';end if;
 if (select count(*) from jsonb_object_keys(r))<>cardinality(keys) or r-keys<>'{}'::jsonb then raise exception 'local issuer fields refused' using errcode='22023';end if;
 foreach k in array array['credentialId','tenantId']||(case when p_purpose='local-custody-credential-issue' then array['policyId','activationEventId','workloadId'] else array[]::text[] end) loop
  if jsonb_typeof(r->k) is distinct from 'string' or r->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then raise exception 'local issuer identity refused' using errcode='22023';end if;
 end loop;
 if jsonb_typeof(r->'reason') is distinct from 'string' or length(r->>'reason') not between 1 and 2000 or r->>'reason' !~ '[^[:space:]]' then raise exception 'local issuer reason required' using errcode='22023';end if;
 if p_purpose='local-custody-credential-issue' then
  foreach k in array array['policySha256','configurationSha256'] loop
   if jsonb_typeof(r->k) is distinct from 'string' or r->>k !~ '^[a-f0-9]{64}$' then raise exception 'local issuer digest refused' using errcode='22023';end if;
  end loop;
  foreach k in array array['operatorId','predecessorId'] loop
   if r->k<>'null'::jsonb and (jsonb_typeof(r->k) is distinct from 'string' or r->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') then raise exception 'local issuer optional identity refused' using errcode='22023';end if;
  end loop;
  if r->>'principalKind' not in ('operator','producer','controller') or r->>'principalKind' is null
   or jsonb_typeof(r->'servicePrincipal') is distinct from 'string' or length(r->>'servicePrincipal') not between 1 and 2048
   or ((r->>'principalKind'='operator') is distinct from (r->'operatorId'<>'null'::jsonb))
   or r->>'predecessorId'=r->>'credentialId' then raise exception 'local issuer principal refused' using errcode='22023';end if;
  foreach k in array array['activationEpoch','issuedAt','expiresAt'] loop
   if jsonb_typeof(r->k) is distinct from 'number' then raise exception 'local issuer time refused' using errcode='22023';end if;
   v:=(r->>k)::numeric;
   if v<>trunc(v) or v not between 1 and 9007199254740991 then raise exception 'local issuer integer refused' using errcode='22023';end if;
  end loop;
  if (r->>'expiresAt')::numeric-(r->>'issuedAt')::numeric not between 1 and 86400 then raise exception 'local credential exceeds original24hour bound' using errcode='22023';end if;
 else
  if jsonb_typeof(r->'issuanceSha256') is distinct from 'string' or r->>'issuanceSha256' !~ '^[a-f0-9]{64}$' then raise exception 'local issuance digest refused' using errcode='22023';end if;
 end if;
 return r;
end $$;

create function controller_security.local_custody_credential_status(p_id uuid,p_tenant uuid,p_issuance_sha text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c controller_security.local_custody_credentials;i controller_security.local_custody_issuances;v controller_security.local_custody_revocations;r jsonb;l public.audit_ledger;
begin
 perform controller_security.local145_require_issuer();
 select * into i from controller_security.local_custody_issuances where credential_id=p_id and tenant_id=p_tenant and request_sha256=p_issuance_sha;
 select * into c from controller_security.local_custody_credentials where id=i.credential_id and tenant_id=p_tenant;
 if c.id is null or i.credential_id is null then raise exception 'local issued credential unavailable' using errcode='42501';end if;
 select * into v from controller_security.local_custody_revocations where credential_id=c.id and tenant_id=c.tenant_id;
 select * into l from public.audit_ledger where id=i.receipt_id and tenant_id=i.tenant_id;
 r:=i.request_text::jsonb;
 perform controller_security.local145_require_issuer();
 return jsonb_build_object('version',1,'state','recorded','credentialId',c.id,'tenantId',c.tenant_id,'policyId',i.policy_id,'policySha256',r->>'policySha256',
  'activationEventId',i.activation_event_id,'activationEpoch',i.activation_epoch,'configurationSha256',c.configuration_sha256,'workloadId',c.workload_id,'principalKind',c.principal_kind,'servicePrincipal',c.service_principal,'operatorId',c.operator_id,
  'issuanceSha256',i.request_sha256,'predecessorId',i.predecessor_id,'issuedAt',r->'issuedAt','expiresAt',r->'expiresAt',
  'status',case when c.revoked_at is not null then 'revoked' when c.expires_at<=clock_timestamp() then 'expired' else 'active' end,
  'revokedAt',c.revoked_at,'revocationSha256',v.request_sha256,'issuanceReceipt',jsonb_build_object('id',l.id::text,'entryHash',l.entry_hash),
  'revocationReceipt',case when v.credential_id is null then null else (select jsonb_build_object('id',id::text,'entryHash',entry_hash) from public.audit_ledger where tenant_id=v.tenant_id and id=v.receipt_id) end);
end $$;

create function controller_security.issue_local_custody_credential(p_text text,p_sha text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;p public.local_custody_policy_versions;h public.local_custody_policy_heads;v jsonb;a public.local_custody_policy_events;f public.local_custody_policy_events;o public.local_custody_policy_events;
 old controller_security.local_custody_issuances;prior controller_security.local_custody_credentials;prior_issue controller_security.local_custody_issuances;cred uuid;tenant uuid;issued numeric;expiry numeric;receipt bigint;
begin
 perform controller_security.local145_require_issuer();r:=controller_security.local145_request(p_text,p_sha,'local-custody-credential-issue');
 cred:=(r->>'credentialId')::uuid;tenant:=(r->>'tenantId')::uuid;
 -- Policy transitions take exclusive47 first. No credential/member ->47 edge.
 perform pg_advisory_xact_lock_shared(hashtextextended(tenant::text,47));
 perform pg_advisory_xact_lock(hashtextextended('axiom.local-custody.issue.'||cred::text,0));
 select * into old from controller_security.local_custody_issuances where credential_id=cred;
 if old.credential_id is not null then
  if old.tenant_id is distinct from tenant or old.request_sha256 is distinct from p_sha or old.request_text is distinct from p_text then raise exception 'local credential operation conflict' using errcode='23505';end if;
  -- Historical positive reconciliation never renews/reactivates a credential.
  perform controller_security.local145_require_issuer();
  return controller_security.local_custody_credential_status(cred,tenant,p_sha);
 end if;
 if exists(select 1 from controller_security.local_custody_credentials where id=cred) then raise exception 'unissued credential cannot be adopted' using errcode='23505';end if;
 select * into p from public.local_custody_policy_versions where tenant_id=tenant and id=(r->>'policyId')::uuid;
 select * into h from public.local_custody_policy_heads where tenant_id=tenant and policy_id=p.id;
 select * into a from public.local_custody_policy_events where tenant_id=tenant and policy_id=p.id and id=(r->>'activationEventId')::uuid and transition='activate';
 select * into f from public.local_custody_policy_events where tenant_id=tenant and policy_id=p.id and id=a.previous_event_id and transition='approve';
 select * into o from public.local_custody_policy_events where tenant_id=tenant and policy_id=p.id and id=f.previous_event_id and transition='request' and previous_event_id is null;
 if p.id is null or h.policy_id is null or a.id is null or f.id is null or o.id is null then raise exception 'approved local custody chain required' using errcode='42501';end if;
 v:=controller_security.local143_policy(p.policy_text);
 perform 1 from public.tenant_users where tenant_id=tenant and user_id in (o.actor_id,f.actor_id,a.actor_id,p.nominated_operator_id) order by user_id for share;
 perform 1 from public.users where id in (o.actor_id,f.actor_id,a.actor_id,p.nominated_operator_id) order by id for no key update;
 perform 1 from public.tenants where id=tenant for share;
 perform 1 from public.workload_identities where id=(r->>'workloadId')::uuid and tenant_id=tenant for share;
 if h.state<>'active' or h.activation_epoch is distinct from a.activation_epoch or a.activation_epoch is distinct from (r->>'activationEpoch')::bigint
  or p.policy_sha256 is distinct from r->>'policySha256' or p.tenant_id is distinct from tenant
  or v->>'deploymentBindingSha256' is distinct from r->>'configurationSha256'
  or (v->>'targetWorkloadId')::uuid is distinct from (r->>'workloadId')::uuid
  or (p.mode='local_demo' and not exists(select 1 from public.tenants where id=tenant and is_demo))
  or not controller_security.local143_actor(tenant,o.actor_id,'request',v)
  or not controller_security.local143_actor(tenant,f.actor_id,'approve',v)
  or not controller_security.local143_actor(tenant,a.actor_id,'activate',v)
  or a.actor_id is distinct from p.nominated_operator_id
  or (r->>'principalKind'='operator' and ((r->>'operatorId')::uuid is distinct from p.nominated_operator_id or r->>'servicePrincipal' is distinct from ('operator:'||p.nominated_operator_id::text)))
  or (r->>'principalKind'<>'operator' and r->>'servicePrincipal' is distinct from (v->'servicePrincipals'->>(r->>'principalKind')))
  or not exists(select 1 from public.workload_identities where id=(r->>'workloadId')::uuid and tenant_id=tenant and agent_name='parikshan' and status='active')
 then raise exception 'live local custody authority refused' using errcode='42501';end if;
 -- Existing143 deferred reciprocal guards establish each human receipt; still
 -- require all three retained events to have their actual same-tenant receipt.
 if exists(select 1 from (values(o.id,o.receipt_id,o.actor_id,o.request_sha256,'custody.local_policy_requested'),(f.id,f.receipt_id,f.actor_id,f.request_sha256,'custody.local_policy_approved'),(a.id,a.receipt_id,a.actor_id,a.request_sha256,'custody.local_policy_activated')) events(id,receipt_id,actor_id,request_sha,action)
  where not exists(select 1 from public.audit_ledger l where l.tenant_id=tenant and l.id=events.receipt_id and l.actor_type='human' and l.actor_id=events.actor_id::text and l.target_ref=events.id::text and l.action_type::text=events.action and l.input_hash=events.request_sha and l.output_hash=p.policy_sha256))
 then raise exception 'local custody receipt chain refused' using errcode='42501';end if;
 if r->'predecessorId'<>'null'::jsonb then
  select * into prior from controller_security.local_custody_credentials where id=(r->>'predecessorId')::uuid for update;
  select * into prior_issue from controller_security.local_custody_issuances where credential_id=prior.id and tenant_id=tenant;
  if prior.id is null or prior_issue.credential_id is null or prior.revoked_at is not null or prior.expires_at<=clock_timestamp()
   or prior.tenant_id is distinct from tenant or prior.workload_id is distinct from (r->>'workloadId')::uuid
   or prior.configuration_sha256 is distinct from r->>'configurationSha256' or prior.service_principal is distinct from r->>'servicePrincipal'
   or prior.principal_kind is distinct from r->>'principalKind' or prior.operator_id is distinct from (r->>'operatorId')::uuid
   or prior_issue.policy_id is distinct from p.id or prior_issue.activation_event_id is distinct from a.id or prior_issue.activation_epoch is distinct from a.activation_epoch
  then raise exception 'local credential predecessor refused' using errcode='42501';end if;
 end if;
 -- Original request times are checked after waits; no lock or retry renews them.
 issued:=(r->>'issuedAt')::numeric;expiry:=(r->>'expiresAt')::numeric;
 if issued>extract(epoch from clock_timestamp()) or expiry<=extract(epoch from clock_timestamp()) then raise exception 'local credential original expiry refused' using errcode='42501';end if;
 -- Membership/role revocation while waiting must withhold every new write.
 perform controller_security.local145_require_issuer();
 insert into controller_security.local_custody_credentials(id,tenant_id,workload_id,configuration_sha256,service_principal,principal_kind,operator_id,expires_at)
 values(cred,tenant,(r->>'workloadId')::uuid,r->>'configurationSha256',r->>'servicePrincipal',r->>'principalKind',(r->>'operatorId')::uuid,to_timestamp(expiry::double precision));
 receipt:=public.append_ledger(tenant,cred,'system','axiom-local-custody-issuer',null,null,null,'custody.local_credential_issued',cred::text,p_sha,p.policy_sha256,null,null,null,null,'success',jsonb_build_object('credential_id',cred,'policy_id',p.id,'activation_event_id',a.id,'activation_epoch',a.activation_epoch,'configuration_sha256',r->>'configurationSha256'));
 insert into controller_security.local_custody_issuances values(cred,tenant,p.id,a.id,a.activation_epoch,(r->>'predecessorId')::uuid,p_text,p_sha,receipt,clock_timestamp());
 return controller_security.local_custody_credential_status(cred,tenant,p_sha);
end $$;

create function controller_security.revoke_local_custody_credential(p_text text,p_sha text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;i controller_security.local_custody_issuances;old controller_security.local_custody_revocations;c controller_security.local_custody_credentials;cred uuid;tenant uuid;receipt bigint;
begin
 perform controller_security.local145_require_issuer();r:=controller_security.local145_request(p_text,p_sha,'local-custody-credential-revoke');
 cred:=(r->>'credentialId')::uuid;tenant:=(r->>'tenantId')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(tenant::text,47));
 perform pg_advisory_xact_lock(hashtextextended('axiom.local-custody.issue.'||cred::text,0));
 select * into i from controller_security.local_custody_issuances where credential_id=cred and tenant_id=tenant and request_sha256=r->>'issuanceSha256';
 select * into c from controller_security.local_custody_credentials where id=i.credential_id and tenant_id=tenant for update;
 if i.credential_id is null or c.id is null then raise exception 'local issued credential unavailable' using errcode='42501';end if;
 select * into old from controller_security.local_custody_revocations where credential_id=cred;
 if old.credential_id is not null then
  if old.request_text is distinct from p_text or old.request_sha256 is distinct from p_sha then raise exception 'local revocation operation conflict' using errcode='23505';end if;
  return controller_security.local_custody_credential_status(cred,tenant,i.request_sha256);
 end if;
 if c.revoked_at is not null then raise exception 'unrecorded local revocation refused' using errcode='42501';end if;
 -- Emergency credential revocation remains possible after policy/actor retirement;
 -- it grants no execution and never removes/revokes an accepted grant itself.
 perform controller_security.local145_require_issuer();
 update controller_security.local_custody_credentials set revoked_at=clock_timestamp() where id=cred;
 receipt:=public.append_ledger(tenant,cred,'system','axiom-local-custody-issuer',null,null,null,'custody.local_credential_revoked',cred::text,p_sha,i.request_sha256,null,null,null,null,'success',jsonb_build_object('credential_id',cred,'policy_id',i.policy_id,'issuance_sha256',i.request_sha256));
 insert into controller_security.local_custody_revocations values(cred,tenant,p_text,p_sha,receipt,clock_timestamp());
 return controller_security.local_custody_credential_status(cred,tenant,i.request_sha256);
end $$;

create function controller_security.local145_receipt_binding() returns trigger language plpgsql security definer set search_path='' as $$
declare i controller_security.local_custody_issuances;v controller_security.local_custody_revocations;c controller_security.local_custody_credentials;l public.audit_ledger;r jsonb;revoke_event boolean;
begin
 if tg_table_name='audit_ledger' then
  if new.action_type::text not in ('custody.local_credential_issued','custody.local_credential_revoked') then return null;end if;
  l:=new;revoke_event:=l.action_type::text='custody.local_credential_revoked';
  if revoke_event then select * into v from controller_security.local_custody_revocations where tenant_id=l.tenant_id and receipt_id=l.id;else select * into i from controller_security.local_custody_issuances where tenant_id=l.tenant_id and receipt_id=l.id;end if;
  if (revoke_event and v.credential_id is null) or (not revoke_event and i.credential_id is null) then raise exception 'local issuer reciprocal fact missing' using errcode='23514';end if;
 elsif tg_table_name='local_custody_revocations' then v:=new;revoke_event:=true;
 else i:=new;revoke_event:=false;end if;
 if revoke_event then
  select * into i from controller_security.local_custody_issuances where credential_id=v.credential_id and tenant_id=v.tenant_id;
  select * into l from public.audit_ledger where tenant_id=v.tenant_id and id=v.receipt_id;
  r:=controller_security.local145_request(v.request_text,v.request_sha256,'local-custody-credential-revoke');
 else
  select * into l from public.audit_ledger where tenant_id=i.tenant_id and id=i.receipt_id;
  r:=controller_security.local145_request(i.request_text,i.request_sha256,'local-custody-credential-issue');
 end if;
 select * into c from controller_security.local_custody_credentials where id=i.credential_id and tenant_id=i.tenant_id;
 if i.credential_id is null or c.id is null or l.id is null or (revoke_event and v.credential_id is null)
  or l.actor_type::text is distinct from 'system' or l.actor_id is distinct from 'axiom-local-custody-issuer'
  or l.correlation_id is distinct from c.id or l.target_ref is distinct from c.id::text or l.result::text is distinct from 'success'
  or (r->>'credentialId')::uuid is distinct from c.id or (r->>'tenantId')::uuid is distinct from c.tenant_id
 then raise exception 'local issuer reciprocal receipt refused' using errcode='23514';end if;
 if revoke_event then
  if l.action_type::text<>'custody.local_credential_revoked' or l.input_hash is distinct from v.request_sha256 or l.output_hash is distinct from i.request_sha256
   or r->>'issuanceSha256' is distinct from i.request_sha256 or c.revoked_at is null
   or l.detail is distinct from jsonb_build_object('credential_id',c.id,'policy_id',i.policy_id,'issuance_sha256',i.request_sha256)
  then raise exception 'local revocation binding refused' using errcode='23514';end if;
 else
  if l.action_type::text<>'custody.local_credential_issued' or l.input_hash is distinct from i.request_sha256 or l.output_hash is distinct from r->>'policySha256'
   or i.policy_id is distinct from (r->>'policyId')::uuid or i.activation_event_id is distinct from (r->>'activationEventId')::uuid or i.activation_epoch is distinct from (r->>'activationEpoch')::bigint
   or i.predecessor_id is distinct from (r->>'predecessorId')::uuid or c.workload_id is distinct from (r->>'workloadId')::uuid or c.configuration_sha256 is distinct from r->>'configurationSha256'
   or c.principal_kind is distinct from r->>'principalKind' or c.service_principal is distinct from r->>'servicePrincipal' or c.operator_id is distinct from (r->>'operatorId')::uuid
   or c.expires_at is distinct from to_timestamp((r->>'expiresAt')::double precision)
   or l.detail is distinct from jsonb_build_object('credential_id',c.id,'policy_id',i.policy_id,'activation_event_id',i.activation_event_id,'activation_epoch',i.activation_epoch,'configuration_sha256',c.configuration_sha256)
  then raise exception 'local issuance binding refused' using errcode='23514';end if;
 end if;
 return null;
end $$;
create constraint trigger local145_issuance_receipt after insert on controller_security.local_custody_issuances deferrable initially deferred for each row execute function controller_security.local145_receipt_binding();
create constraint trigger local145_revocation_receipt after insert on controller_security.local_custody_revocations deferrable initially deferred for each row execute function controller_security.local145_receipt_binding();
create constraint trigger local145_ledger_receipt after insert on public.audit_ledger deferrable initially deferred for each row execute function controller_security.local145_receipt_binding();
-- Legacy143 manually provisioned fixtures remain readable; a credential marked as
-- issued145 cannot be revoked without its reciprocal immutable revocation fact.
create function controller_security.local145_credential_revocation_binding() returns trigger language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from controller_security.local_custody_issuances where credential_id=new.id)
  and new.revoked_at is not null and not exists(select 1 from controller_security.local_custody_revocations where credential_id=new.id and tenant_id=new.tenant_id)
 then raise exception 'local credential revocation receipt missing' using errcode='23514';end if;return null;
end $$;
create constraint trigger local145_credential_revocation after update on controller_security.local_custody_credentials deferrable initially deferred for each row execute function controller_security.local145_credential_revocation_binding();

do $$declare f record;begin
 for f in select p.oid::regprocedure sig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='controller_security' and (p.proname like 'local145_%' or p.proname in ('local_custody_credential_status','issue_local_custody_credential','revoke_local_custody_credential')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_controller_issuer,axiom_local_custody_issuer',f.sig);
 end loop;
end $$;
grant usage on schema controller_security to axiom_local_custody_issuer;
grant execute on function controller_security.issue_local_custody_credential(text,text),controller_security.revoke_local_custody_credential(text,text),controller_security.local_custody_credential_status(uuid,uuid,text) to axiom_local_custody_issuer;
