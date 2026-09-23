-- Append-only correction: managed Supabase installs pgcrypto in extensions;
-- clean PostgreSQL installs it in public. Use the built-in SHA256 in both,
-- preserving an empty search_path and identical UTF8 review-byte binding.
create or replace function controller_security.checked_request(p_text text,p_sha text,p_purpose text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v jsonb; expected text[]; k text; n int;
begin
 if p_text is null or octet_length(p_text)>4096 or p_sha is null or p_sha !~ '^[0-9a-f]{64}$'
  or encode(pg_catalog.sha256(convert_to(p_text,'UTF8')),'hex')<>p_sha then raise exception 'credential request refused'; end if;
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

