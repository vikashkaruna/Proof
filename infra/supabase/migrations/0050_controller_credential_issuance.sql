-- Explicit deployment administration only. Never grant this role to an
-- application, authenticator, SPIRE issuer or tenant runner. A reviewed external
-- operator provisions its login membership separately; this migration does not.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='axiom_controller_issuer') then
  create role axiom_controller_issuer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='axiom_controller_issuer' and
  (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='axiom_controller_issuer')
 then raise exception 'controller issuer role refused'; end if;
end $$;

create table controller_security.issuances (
 credential_id uuid primary key references controller_security.credentials(id) on delete restrict,
 predecessor_id uuid unique references controller_security.credentials(id) on delete restrict,
 request_sha256 text not null unique check(request_sha256 ~ '^[0-9a-f]{64}$'),
 request_text text not null check(octet_length(request_text)<=4096),
 created_at timestamptz not null default clock_timestamp()
);
create table controller_security.revocations (
 credential_id uuid primary key references controller_security.issuances(credential_id) on delete restrict,
 request_sha256 text not null unique check(request_sha256 ~ '^[0-9a-f]{64}$'),
 request_text text not null check(octet_length(request_text)<=4096),
 created_at timestamptz not null default clock_timestamp()
);
revoke all on controller_security.issuances,controller_security.revocations from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;

create function controller_security.fixed_issuance() returns trigger
language plpgsql security definer set search_path='' as $$
begin raise exception 'credential review records are immutable' using errcode='42501'; end $$;
revoke all on function controller_security.fixed_issuance() from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;
create trigger fixed_issuance before update or delete on controller_security.issuances for each row execute function controller_security.fixed_issuance();
create trigger fixed_revocation before update or delete on controller_security.revocations for each row execute function controller_security.fixed_issuance();

-- Legacy manually provisioned fixtures are unchanged. Issued credentials cannot
-- be retargeted, extended, deleted or unrevoked, even accidentally by an admin.
create function controller_security.fixed_credential() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from controller_security.issuances where credential_id=old.id) then
  if tg_op='DELETE' then raise exception 'issued credential deletion refused' using errcode='42501'; end if;
  if (new.id,new.tenant_id,new.created_at,new.expires_at) is distinct from (old.id,old.tenant_id,old.created_at,old.expires_at)
   or (new.revoked_at is distinct from old.revoked_at and
    (old.revoked_at is not null or new.revoked_at is null or new.revoked_at<old.created_at or new.revoked_at>clock_timestamp()))
  then raise exception 'issued credential mutation refused' using errcode='42501'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
revoke all on function controller_security.fixed_credential() from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;
create trigger fixed_credential before update or delete on controller_security.credentials for each row execute function controller_security.fixed_credential();

create function controller_security.checked_request(p_text text,p_sha text,p_purpose text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v jsonb; expected text[]; k text; n int;
begin
 if p_text is null or octet_length(p_text)>4096 or p_sha is null or p_sha !~ '^[0-9a-f]{64}$'
  or encode(extensions.digest(convert_to(p_text,'UTF8'),'sha256'),'hex')<>p_sha then raise exception 'credential request refused'; end if;
 v:=p_text::jsonb;
 if jsonb_typeof(v)<>'object' or v->'schemaVersion' is distinct from '1'::jsonb or v->>'purpose' is distinct from p_purpose
 then raise exception 'credential request refused'; end if;
 expected:=array['schemaVersion','purpose','credentialId','tenantId','configurationSha256','approvalReference'];
 if p_purpose='controller-backend-issue' then expected:=expected||array['predecessorId','issuedAt','expiresAt'];
 elsif p_purpose='controller-backend-revoke' then expected:=expected||array['issuanceSha256'];
 else raise exception 'credential purpose refused'; end if;
 select count(*) into n from json_object_keys(p_text::json);
 if n<>cardinality(expected) or (select count(*) from jsonb_object_keys(v))<>n or v-array_remove(expected,null)<>'{}'::jsonb
 then raise exception 'credential request fields refused'; end if;
 foreach k in array array['credentialId','tenantId','approvalReference'] loop
  if jsonb_typeof(v->k) is distinct from 'string' or v->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or (v->>k)::uuid='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'credential identifier refused'; end if;
 end loop;
 if jsonb_typeof(v->'configurationSha256') is distinct from 'string' or v->>'configurationSha256' !~ '^[0-9a-f]{64}$' then raise exception 'credential configuration refused'; end if;
 return v;
end $$;
revoke all on function controller_security.checked_request(text,text,text) from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;

create function controller_security.credential_status(p_id uuid,p_tenant uuid,p_sha text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c controller_security.credentials; i controller_security.issuances; v jsonb;
begin
 select * into c from controller_security.credentials where id=p_id and tenant_id=p_tenant;
 select * into i from controller_security.issuances where credential_id=p_id and request_sha256=p_sha;
 if c.id is null or i.credential_id is null then raise exception 'issued credential unavailable' using errcode='42501'; end if;
 v:=i.request_text::jsonb;
 return jsonb_build_object('schemaVersion',1,'credentialId',c.id,'tenantId',c.tenant_id,'requestSha256',i.request_sha256,
  'predecessorId',i.predecessor_id,'issuedAt',v->'issuedAt','expiresAt',v->'expiresAt',
  'status',case when c.revoked_at is not null then 'revoked' when c.expires_at<=statement_timestamp() then 'expired' else 'active' end);
end $$;
revoke all on function controller_security.credential_status(uuid,uuid,text) from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;

create function controller_security.issue_credential(p_text text,p_sha text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb; identity uuid; tenant uuid; predecessor uuid; issued numeric; expiry numeric;
 existing controller_security.issuances; prior controller_security.credentials; result jsonb; k text;
begin
 v:=controller_security.checked_request(p_text,p_sha,'controller-backend-issue');
 identity:=(v->>'credentialId')::uuid;tenant:=(v->>'tenantId')::uuid;
 foreach k in array array['issuedAt','expiresAt'] loop
  if jsonb_typeof(v->k) is distinct from 'number' or (v->>k)::numeric<>trunc((v->>k)::numeric) then raise exception 'credential time refused'; end if;
 end loop;
 issued:=(v->>'issuedAt')::numeric;expiry:=(v->>'expiresAt')::numeric;
 if issued<0 or expiry-issued<300 or expiry-issued>3600 then raise exception 'credential lifetime refused'; end if;
 if v->'predecessorId'<>'null'::jsonb then
  if jsonb_typeof(v->'predecessorId') is distinct from 'string' or v->>'predecessorId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then raise exception 'credential predecessor refused'; end if;
  predecessor:=(v->>'predecessorId')::uuid;
  if predecessor=identity or predecessor='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'credential predecessor refused'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('axiom.controller.issue.'||identity::text,0));
 select * into existing from controller_security.issuances where credential_id=identity;
 if existing.credential_id is not null then
  if existing.request_sha256<>p_sha or existing.request_text<>p_text then raise exception 'credential review changed'; end if;
  result:=controller_security.credential_status(identity,tenant,p_sha);
  if result->>'status'<>'active' then raise exception 'credential no longer active'; end if;
  return result;
 end if;
 if issued>extract(epoch from clock_timestamp()) or issued<extract(epoch from clock_timestamp())-300
  or expiry<=extract(epoch from clock_timestamp())+60 then raise exception 'credential issue window refused'; end if;
 if predecessor is not null then
  select * into prior from controller_security.credentials where id=predecessor for update;
  if prior.id is null or prior.tenant_id<>tenant or prior.revoked_at is not null or prior.expires_at<=clock_timestamp()
   or not exists(select 1 from controller_security.issuances where credential_id=predecessor)
   then raise exception 'credential predecessor unavailable'; end if;
 end if;
 insert into controller_security.credentials(id,tenant_id,expires_at) values(identity,tenant,to_timestamp(expiry::double precision));
 insert into controller_security.issuances(credential_id,predecessor_id,request_sha256,request_text) values(identity,predecessor,p_sha,p_text);
 return controller_security.credential_status(identity,tenant,p_sha);
end $$;
revoke all on function controller_security.issue_credential(text,text) from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;

create function controller_security.revoke_credential(p_text text,p_sha text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb; identity uuid; tenant uuid; old controller_security.revocations; status jsonb;
begin
 v:=controller_security.checked_request(p_text,p_sha,'controller-backend-revoke');
 if jsonb_typeof(v->'issuanceSha256') is distinct from 'string' or v->>'issuanceSha256' !~ '^[0-9a-f]{64}$' then raise exception 'issuance reference refused'; end if;
 identity:=(v->>'credentialId')::uuid;tenant:=(v->>'tenantId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('axiom.controller.issue.'||identity::text,0));
 perform 1 from controller_security.credentials where id=identity for update;
 status:=controller_security.credential_status(identity,tenant,v->>'issuanceSha256');
 select * into old from controller_security.revocations where credential_id=identity;
 if old.credential_id is not null then
  if old.request_text<>p_text or old.request_sha256<>p_sha then raise exception 'revocation review changed'; end if;
  return status;
 end if;
 if status->>'status'='revoked' then raise exception 'unreviewed prior revocation refused'; end if;
 update controller_security.credentials set revoked_at=clock_timestamp() where id=identity;
 insert into controller_security.revocations(credential_id,request_sha256,request_text) values(identity,p_sha,p_text);
 return controller_security.credential_status(identity,tenant,v->>'issuanceSha256');
end $$;
revoke all on function controller_security.revoke_credential(text,text) from public,anon,authenticated,service_role,axiom_assessment_controller,axiom_controller_issuer;
grant usage on schema controller_security to axiom_controller_issuer;
grant execute on function controller_security.issue_credential(text,text),controller_security.revoke_credential(text,text),controller_security.credential_status(uuid,uuid,text) to axiom_controller_issuer;
