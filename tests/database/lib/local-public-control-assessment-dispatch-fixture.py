"""Pure147 synthetic fixture generator. No SQL/resource execution.

Reuses the exact46-control reviewed capture fixture, not a parallel catalogue.
The optional committed form is restricted to an explicitly owned race template.
MFA/session rows are synthetic SQL foundations, never real Auth acceptance.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REVIEW_SHA = "a221a1fb1c39e3ace5ea36b5347d02de025d1535b895b0288548b76970b3194a"
# Reviewed178 test-only immutable-scope rejection; emitted asset setup prefix is unchanged.
ASSET_SHA = "ae33189bc266771c5dc839caa552e87fc0e7bd1ff2e1daa9261fccd49ada381c"
SCHEMA = "local147_fixture"


def asset_setup(root: Path = ROOT) -> str:
    raw = (
        root / "tests/database/public-control-review-asset-sources.test.sql"
    ).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ASSET_SHA:
        raise ValueError("reviewed_asset_fixture_changed")
    text = raw.decode("utf8")
    text = text[
        text.index("-- Distinct human metadata") : text.index(
            "create function pg_temp.refused2"
        )
    ]
    text = text.replace("pg_temp.", SCHEMA + ".")
    text = text.replace(
        "create temporary table asset_operations",
        "create table local147_fixture.asset_operations",
    )
    text = re.sub(r"(?<!\.)\basset_operations\b", SCHEMA + ".asset_operations", text)
    text = re.sub(r"(?<!\.)\bsaved_check\b", SCHEMA + ".saved_check", text)
    return (
        text
        + """
update local147_fixture.review set value=local147_fixture.save(local147_fixture.request2(81,(value->>'id')::uuid),local147_fixture.id(5))->'data';
"""
    )


def setup(root: Path = ROOT, *, committed: bool = False) -> str:
    raw = (root / "tests/database/public-control-review-set.test.sql").read_bytes()
    if hashlib.sha256(raw).hexdigest() != REVIEW_SHA:
        raise ValueError("reviewed_capture_fixture_changed")
    text = raw.decode("utf8")
    text = text[
        text.index("create function pg_temp.id") : text.index("select pg_temp.refused")
    ]
    start = text.index("insert into public.control_libraries")
    controls = text.index("insert into public.controls")
    end = text.index("\n", controls)
    seed_sql = text[start:end]
    seed = re.search(r"\$seed\$(.*?)\$seed\$", seed_sql, re.DOTALL)
    change = re.search(
        r"values\('0.1.1','2026-09-20','Axiom Minds · Founder',(.*),46,'published'\);",
        text[start:controls],
        re.DOTALL,
    )
    if seed is None or change is None:
        raise ValueError("reviewed_capture_prefix_changed")
    reuse = (
        """do $reuse$ declare expected jsonb:=$seed$"""
        + seed[1]
        + """$seed$::jsonb;begin
 if not exists(select 1 from public.control_libraries where version='0.1.1') then
 """
        + seed_sql
        + """
 elsif not exists(select 1 from public.control_libraries where version='0.1.1' and published_at='2026-09-20'::timestamptz and published_by='Axiom Minds · Founder' and change_log="""
        + change[1]
        + """ and control_count=46 and status='published')
 or (select count(*) from public.controls where library_version='0.1.1')<>46
 or exists(select 1 from jsonb_array_elements(expected) e left join public.controls c on c.id=e->>'id' and c.library_version='0.1.1' where c.id is null or (select jsonb_object_agg(key,to_jsonb(c)->key) from jsonb_object_keys(e) key) is distinct from e)
 then raise exception 'immutable fixture catalogue differs';end if;end $reuse$;
"""
    )
    text = text[:start] + reuse + text[end:]
    text = text.replace("pg_temp.", SCHEMA + ".").replace("99133400-", "99134700-")
    text = text.replace("review-core-", "local147-")
    text = text.replace(
        "create temporary table saved_check",
        "create table local147_fixture.saved_check",
    )
    text = text.replace("from saved_check", "from local147_fixture.saved_check")
    owned = (
        """
do $owned$begin
 if current_database() !~ '^axiom_proof_local_147_[a-f0-9]{12}_template$'
 or current_user<>'supabase_admin' or session_user<>'supabase_admin'
 then raise exception 'owned147 template only' using errcode='42501';end if;
end $owned$;
"""
        if committed
        else ""
    )
    return (
        "begin;\n"
        + owned
        + """
create schema local147_fixture;
grant usage on schema local147_fixture to human_action_writer,axiom_assessment_controller;
-- Only an absent rollback-scoped SQL stand-in is created. No live Auth grants.
do $auth$declare prior text:=current_user;begin
 if to_regclass('auth.sessions') is null then
  set local role postgres;
  create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
  execute format('set local role %I',prior);
 end if;
end $auth$;
-- Raw retained fixture imports use the original disposable DB session.
reset role;
"""
        + text
        + """
grant execute on function local147_fixture.id(integer) to human_action_writer,axiom_assessment_controller;
create table local147_fixture.review as select local147_fixture.save(local147_fixture.request()) ->'data' value;
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
values(local147_fixture.id(81),local147_fixture.id(31),'parikshan','spiffe://local.axiom/agent/parikshan','active');
insert into auth.sessions(id,user_id,not_after) select local147_fixture.id(100+n),local147_fixture.id(n),null from generate_series(1,3)n;
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)
select local147_fixture.id(140+n),local147_fixture.id(n),'totp','active','synthetic-sealed' from generate_series(1,3)n;
create function local147_fixture.policy() returns jsonb language plpgsql as $$
declare p jsonb;ref text:='axiom-local-dispatch://'||local147_fixture.id(31)||'/'||local147_fixture.id(91)||'/versions/1';begin
 p:=jsonb_build_object('version',1,'policyId',local147_fixture.id(91),'tenantId',local147_fixture.id(31),'mode','operator_managed','nominatedOperatorId',local147_fixture.id(2),'targetWorkloadId',local147_fixture.id(81),
 'servicePrincipals',jsonb_build_object('producer','spiffe://local.axiom/service/assessment-dispatch-producer','controller','spiffe://local.axiom/controller/assessment'),
 'validity',jsonb_build_object('kind','until_revoked','reviewDueAt',1),'actionClass','assessment_dispatch_key_custody',
 'keyPolicy',jsonb_build_object('primary',ref,'readable',jsonb_build_array(ref)),'deploymentBindingSha256',repeat('b',64),
 'reason','Explicit synthetic local custody limitation','acceptedLimitations',jsonb_build_array('hardware_backing_unverified'),'statutoryComplianceAsserted',false,'ownershipVerified',false);
 return p||jsonb_build_object('keyPolicySha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local.dispatch.policy',1,p->>'tenantId',p->>'policyId',p->>'mode',p->'validity',ref,jsonb_build_array(ref))),'UTF8')),'hex'));
end $$;
create function local147_fixture.policy_request(k int,transition text,previous uuid default null) returns text language sql as $$
select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',local147_fixture.id(k),'transition',transition,'policyText',controller_security.canonical_questionnaire_json(local147_fixture.policy()),'policySha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(local147_fixture.policy()),'UTF8')),'hex'),'previousEventId',previous,'nextReviewDueAt',null,'reason','Synthetic explicit custody decision','confirmed',true))$$;
create function local147_fixture.policy_write(txt text,actor int) returns jsonb language plpgsql as $$
declare c uuid:=gen_random_uuid();r jsonb:=txt::jsonb;binding text;v jsonb;begin
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local-custody.transition',1,local147_fixture.id(31)::text,local147_fixture.id(actor)::text,local147_fixture.id(100+actor)::text,encode(sha256(convert_to(txt,'UTF8')),'hex'))),'UTF8')),'hex');
 insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at,satisfied_at,consumed_at,consumed_for,satisfied_with)
 values(c,local147_fixture.id(actor),local147_fixture.id(31),local147_fixture.id(140+actor),'local_custody_policy',r->>'operationKey',binding,clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '4 minutes 50 seconds',clock_timestamp()-interval '1 second',clock_timestamp(),r->>'operationKey','totp');
 set local role human_action_writer;
 v:=public.record_local_custody_policy_event(local147_fixture.id(31),local147_fixture.id(actor),local147_fixture.id(100+actor),txt,c);reset role;return v;
exception when others then reset role;raise;end $$;
create table local147_fixture.policy_saved(kind text primary key,v jsonb);
insert into local147_fixture.policy_saved values('request',local147_fixture.policy_write(local147_fixture.policy_request(151,'request'),3));
insert into local147_fixture.policy_saved select 'approve',local147_fixture.policy_write(local147_fixture.policy_request(152,'approve',(v->>'eventId')::uuid),1) from local147_fixture.policy_saved where kind='request';
insert into local147_fixture.policy_saved select 'activate',local147_fixture.policy_write(local147_fixture.policy_request(153,'activate',(v->>'eventId')::uuid),2) from local147_fixture.policy_saved where kind='approve';
create table local147_fixture.clock(deadline timestamptz not null);
insert into local147_fixture.clock values(clock_timestamp()+interval '10 minutes');
create function local147_fixture.enqueue(n int,actor int default 3,changes jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;s jsonb;input_text text;snap jsonb;outcome jsonb;p jsonb:=local147_fixture.policy();policy_sha text;proof_sha text;begin
 select value into r from local147_fixture.review;
 snap:=(r->>'snapshot_text')::jsonb;
 input_text:=controller_security.canonical_questionnaire_json(jsonb_build_object('tenant_id',local147_fixture.id(31),'engagement_id',local147_fixture.id(41),'library_version','0.1.1','answers',snap->'normalizedAnswers','sdf_self_attested',snap#>'{request,applicability,sdfSelfAttested}','processes_children',snap#>'{request,applicability,processesChildren}','processes_health',snap#>'{request,applicability,processesHealth}'));
 s:=jsonb_build_object('inputSha256',encode(sha256(convert_to(input_text,'UTF8')),'hex'));
 -- Stable full operation UUID makes distinct synthetic task proofs unique;
 -- exact same-operation retries retain the original proof commitment.
 proof_sha:=encode(sha256(convert_to('axiom.local147.task-proof:'||local147_fixture.id(n)::text,'UTF8')),'hex');
 policy_sha:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(p),'UTF8')),'hex');
 set local role human_action_writer;
 outcome:=public.enqueue_local_public_control_assessment_dispatch(local147_fixture.id(n),local147_fixture.id(31),local147_fixture.id(actor),local147_fixture.id(81),(r->>'estate_id')::uuid,local147_fixture.id(41),local147_fixture.id(n),coalesce(changes->>'inputHash',s->>'inputSha256'),proof_sha,(select deadline from local147_fixture.clock),coalesce(changes->>'keyRef',p#>>'{keyPolicy,primary}'),decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),local147_fixture.id(91),coalesce(changes->>'policySha256',policy_sha),p->>'keyPolicySha256',(select (v->>'eventId')::uuid from local147_fixture.policy_saved where kind='activate'),coalesce((changes->>'activationEpoch')::bigint,1),repeat('b',64),(r->>'id')::uuid,coalesce(changes->>'reviewRequestSha256',r->>'request_sha256'),coalesce(changes->>'reviewSnapshotSha256',r->>'snapshot_sha256'));
 reset role;return outcome;
exception when others then reset role;raise;end $$;
grant select on local147_fixture.review,local147_fixture.clock,local147_fixture.policy_saved to human_action_writer;
create function local147_fixture.revoke_policy() returns jsonb language sql as $$select local147_fixture.policy_write(local147_fixture.policy_request(154,'revoke',(select (v->>'eventId')::uuid from local147_fixture.policy_saved where kind='activate')),3)$$;
insert into controller_security.credentials(id,tenant_id,expires_at) values(local147_fixture.id(181),local147_fixture.id(31),clock_timestamp()+interval '1 hour');
-- A real transport JWT is issued before this SQL statement begins. Minting
-- its synthetic iat from wall time inside the statement can cross an epoch
-- second and spuriously fail the legacy statement-time tenant guard. Only
-- this fixture clock changes; production wall-time expiry fences stay intact.
create function local147_fixture.claim(n int,changes jsonb default '{}') returns jsonb language plpgsql as $$
declare p jsonb:=local147_fixture.policy();v jsonb;policy_sha text;begin
 policy_sha:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(p),'UTF8')),'hex');
 perform set_config('request.jwt.claims',jsonb_build_object('role','axiom_assessment_controller','sub',coalesce((changes->>'credentialId')::uuid,local147_fixture.id(181)),'tenant_id',coalesce(changes->>'tenantId',local147_fixture.id(31)::text),'iat',floor(extract(epoch from statement_timestamp()))::bigint,'exp',coalesce((changes->>'exp')::bigint,floor(extract(epoch from statement_timestamp()))::bigint+120))::text,true);
 set local role axiom_assessment_controller;
 v:=public.claim_local_assessment_dispatch(local147_fixture.id(31),local147_fixture.id(n),local147_fixture.id(91),coalesce(changes->>'policySha256',policy_sha),p->>'keyPolicySha256');reset role;return v;
exception when others then reset role;raise;end $$;
set constraints all immediate;set constraints all deferred;
"""
        + asset_setup(root)
        + "\nset constraints all immediate;set constraints all deferred;\n"
        + ("commit;\n" if committed else "")
    )


if __name__ == "__main__":
    import sys

    if sys.argv[1:] not in ([], ["--template"]):
        raise SystemExit("only explicit synthetic template mode accepted")
    print(setup(committed=sys.argv[1:] == ["--template"]))
