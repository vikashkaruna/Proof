-- W4.2 vault persistence. Legacy envelopes are preserved but remain unreadable
-- by the v1 broker; no migration guesses their cryptographic format.
alter type public.ledger_action_type add value if not exists 'connector.credential_changed';
alter table public.connector_credentials drop constraint connector_credentials_grant_type_check;
alter table public.connector_credentials add constraint connector_credentials_grant_type_check
  check(grant_type in ('client_credentials','jwt_bearer','token_exchange','cloud_iam','legacy_static'));
alter table public.connector_credentials
  add column format_version integer not null default 0,
  add column revision integer not null default 1 check(revision>0),
  add column descriptor_sha256 text,
  add column endpoint_ref text,
  add column target_binding text,
  add constraint credential_format check (
    (format_version=0 and descriptor_sha256 is null and endpoint_ref is null and target_binding is null)
    or (format_version=1 and descriptor_sha256 is not null and descriptor_sha256 ~ '^[a-f0-9]{64}$'
      and endpoint_ref is not null and endpoint_ref ~ '^[a-z][a-z0-9_-]{0,79}$'
      and target_binding is not null and target_binding in ('production','sandbox','reference-mock')
      and grant_type in ('client_credentials','jwt_bearer')
      and octet_length(ciphertext)<=32784 and octet_length(wrapped_data_key)<=16384)
  );
create unique index one_current_connector_credential on public.connector_credentials(tenant_id,connector_id)
  where format_version=1 and revoked_at is null;

-- Service-only administrative operation. Caller supplies ciphertext only,
-- never a secret or token. The BFF must seal against trusted connector context.
-- It is intentionally not an agent token-acquisition surface.
create function public.manage_connector_credential(
  p_tenant_id uuid, p_actor_id uuid, p_connector_id uuid, p_credential_id uuid,
  p_operation text, p_connector_version integer, p_expected_revision integer,
  p_envelope jsonb, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  c public.connectors; e public.estates; s public.estate_systems;
  credential public.connector_credentials; d public.connector_descriptors;
  system_id uuid; estate_id uuid; grant_family text; changed_grants integer:=0;
begin
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  if p_operation is null or p_operation not in ('create','rotate','revoke') or p_credential_id is null
    then return jsonb_build_object('error','invalid_operation'); end if;
  select inventory.system_id into system_id from public.connectors inventory where tenant_id=p_tenant_id and id=p_connector_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  select inventory.estate_id into estate_id from public.estate_systems inventory where tenant_id=p_tenant_id and id=system_id;
  -- Same ordering as estate and connector lifecycle mutations.
  select * into e from public.estates where tenant_id=p_tenant_id and id=estate_id for update;
  select * into s from public.estate_systems where tenant_id=p_tenant_id and id=system_id for update;
  select * into c from public.connectors where tenant_id=p_tenant_id and id=p_connector_id for update;
  if c.version is distinct from p_connector_version then return jsonb_build_object('error','version_conflict'); end if;
  if p_operation<>'revoke' and (e.status<>'active' or s.status<>'active' or c.status='archived')
    then return jsonb_build_object('error','parent_archived'); end if;
  select * into credential from public.connector_credentials
    where tenant_id=p_tenant_id and connector_id=c.id and id=p_credential_id for update;
  if p_operation='create' then
    if found or p_expected_revision is distinct from 0 then return jsonb_build_object('error','version_conflict'); end if;
    if exists(select 1 from public.connector_credentials where tenant_id=p_tenant_id and connector_id=c.id and format_version=1 and revoked_at is null)
      then return jsonb_build_object('error','credential_exists'); end if;
  else
    if not found then return jsonb_build_object('error','not_found'); end if;
    if credential.revision is distinct from p_expected_revision or credential.revoked_at is not null
      then return jsonb_build_object('error','version_conflict'); end if;
    if p_operation='rotate' and (credential.format_version<>1 or credential.expires_at<=clock_timestamp())
      then return jsonb_build_object('error','credential_unavailable'); end if;
  end if;
  if p_operation<>'revoke' then
    select * into d from public.connector_descriptors where id=c.descriptor_id;
    grant_family:=p_envelope->>'grantType';
    if jsonb_typeof(p_envelope) is distinct from 'object'
      or p_envelope - array['formatVersion','algorithm','grantType','descriptorSha256','endpointRef','targetBinding','keyRef','nonce','ciphertext','wrappedDataKey'] <> '{}'::jsonb
      or p_envelope->>'formatVersion' is distinct from '1'
      or p_envelope->>'algorithm' is distinct from 'aes-256-gcm'
      or p_envelope->>'descriptorSha256' is distinct from d.content_sha256
      or p_envelope->>'endpointRef' is distinct from c.endpoint_ref
      or p_envelope->>'targetBinding' is distinct from c.target_binding
      or grant_family is null or grant_family not in ('client_credentials','jwt_bearer')
      or d.manifest->>'auth' is distinct from 'oauth2.'||grant_family
      or coalesce(p_envelope->>'keyRef','') !~ '^[a-zA-Z0-9:/_.-]+$'
      or length(p_envelope->>'keyRef')>500
      or coalesce(p_envelope->>'nonce','') !~ '^[a-f0-9]{24}$'
      or coalesce(p_envelope->>'ciphertext','') !~ '^[a-f0-9]+$'
      or length(p_envelope->>'ciphertext') not between 34 and 65568 or length(p_envelope->>'ciphertext')%2<>0
      or coalesce(p_envelope->>'wrappedDataKey','') !~ '^[a-f0-9]+$'
      or length(p_envelope->>'wrappedDataKey') not between 2 and 32768 or length(p_envelope->>'wrappedDataKey')%2<>0
      then return jsonb_build_object('error','invalid_envelope'); end if;
    if p_operation='rotate' and (credential.descriptor_sha256 is distinct from d.content_sha256
      or credential.endpoint_ref is distinct from c.endpoint_ref or credential.target_binding is distinct from c.target_binding
      or credential.grant_type is distinct from grant_family)
      then return jsonb_build_object('error','credential_unavailable'); end if;
    if p_operation='create' then
      insert into public.connector_credentials(id,tenant_id,connector_id,grant_type,key_ref,algorithm,nonce,ciphertext,wrapped_data_key,
        format_version,descriptor_sha256,endpoint_ref,target_binding)
      values(p_credential_id,p_tenant_id,c.id,grant_family,p_envelope->>'keyRef','aes-256-gcm',decode(p_envelope->>'nonce','hex'),
        decode(p_envelope->>'ciphertext','hex'),decode(p_envelope->>'wrappedDataKey','hex'),1,d.content_sha256,c.endpoint_ref,c.target_binding)
      returning * into credential;
    else
      update public.connector_credentials set key_ref=p_envelope->>'keyRef',nonce=decode(p_envelope->>'nonce','hex'),
        ciphertext=decode(p_envelope->>'ciphertext','hex'),wrapped_data_key=decode(p_envelope->>'wrappedDataKey','hex'),revision=revision+1
        where id=p_credential_id returning * into credential;
    end if;
  else
    update public.connector_credentials set revoked_at=clock_timestamp(),revision=revision+1 where id=p_credential_id returning * into credential;
  end if;
  -- An administrative secret replacement must never preserve old authority.
  -- Rotation is conservative: grants need explicit re-approval even for a KEK change.
  update public.connector_grants set revoked_at=clock_timestamp() where tenant_id=p_tenant_id and connector_id=c.id and revoked_at is null;
  get diagnostics changed_grants = row_count;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
    'connector.credential_changed',c.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('operation',p_operation,'credentialId',credential.id,'revision',credential.revision,
      'targetBinding',c.target_binding,'grantsRevoked',changed_grants));
  -- Deliberately no ciphertext, key material, key reference or secret config.
  return jsonb_build_object('credentialId',credential.id,'revision',credential.revision,'revoked',credential.revoked_at is not null);
end $$;
revoke all on function public.manage_connector_credential(uuid,uuid,uuid,uuid,text,integer,integer,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.manage_connector_credential(uuid,uuid,uuid,uuid,text,integer,integer,jsonb,uuid) to service_role;
