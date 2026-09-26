-- W7.3/W7.4 / migration 0070: multi-regulator frameworks, framework
-- controls, control mappings and sector packs.
--
-- What the assertions protect: the catalogue is GLOBAL reference data
-- (every authenticated user reads it), publication is append-only through
-- SECURITY DEFINER paths granted to the service role only, every pack
-- reference resolves to a real published control, and the honest
-- provenance vocabulary is enforced at the gate — an indicative mapping
-- cannot pass as equivalent, and 'vendor-verified' cannot be inserted at
-- all.

begin;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
create function pg_temp.assert_eq(actual text, expected text, message text) returns void language plpgsql as $$
begin if actual is distinct from expected then
  raise exception 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return; end;
  raise exception 'Statement was not denied: %', statement;
end $$;

-- ─── Fixture ─────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'librarian@test.invalid'),
  ('00000000-0000-0000-0000-0000000000b2', 'member@test.invalid');
insert into public.users(id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'librarian@test.invalid'),
  ('00000000-0000-0000-0000-0000000000b2', 'member@test.invalid');
insert into public.control_libraries(version, published_at, published_by, change_log, control_count)
  values ('test-w7', now(), 'test', 'test', 3);
insert into public.controls(id, library_version, title, obligation, domain, severity,
  citations, evidence_required, assessment_questions, scoring, remediation_patterns, introduced_in_version)
values
  ('DPDPA-SEC-001', 'test-w7', 'Fixture security safeguards', 'Fixture obligation text for security safeguards.',
   'SEC', 'high', '[]', '[]', '[]',
   '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'test-w7'),
  ('DPDPA-XBR-001', 'test-w7', 'Fixture cross-border restriction', 'Fixture obligation text for cross-border transfer.',
   'XBR', 'high', '[]', '[]', '[]',
   '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'test-w7'),
  ('DPDPA-BRCH-001', 'test-w7', 'Fixture breach intimation', 'Fixture obligation text for breach intimation.',
   'BRCH', 'critical', '[]', '[]', '[]',
   '{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}', '{}', 'test-w7');

-- ─── Framework publication ───────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.publish_regulatory_framework(
     'RBI-MD-ITG', 'RBI',
     'Master Direction on Information Technology Governance, Risk, Controls and Assurance Practices',
     'RBI baseline IT governance and information security regime.',
     'https://www.rbi.org.in', '2026-09-26', 'Axiom Minds · Founder',
     '00000000-0000-0000-0000-0000000000b1',
     '[{"ref": "it-governance-oversight", "heading": "Board-approved IT governance"},
       {"ref": "it-infosec-controls", "heading": "Information security controls"}]'::jsonb)
   -> 'framework' ->> 'code'),
  'RBI-MD-ITG', 'the framework publishes with its code');

select pg_temp.assert_true(
  (select count(*) = 2 from public.framework_controls fc
    join public.frameworks f on f.id = fc.framework_id
   where f.code = 'RBI-MD-ITG'),
  'both framework controls are published atomically');

select pg_temp.assert_eq(
  (select public.publish_regulatory_framework(
     'RBI-MD-ITG', 'RBI', 'Duplicate', '', 'https://www.rbi.org.in', '2026-09-26', 'v',
     '00000000-0000-0000-0000-0000000000b1', '[{"ref": "x", "heading": "y"}]'::jsonb)
   ->> 'error'),
  'already_published', 'a framework code publishes once');

select pg_temp.assert_eq(
  (select public.publish_regulatory_framework(
     'RBI-FAKE', 'TRAI', 'Wrong regulator', '', 'https://www.rbi.org.in', '2026-09-26', 'v',
     '00000000-0000-0000-0000-0000000000b1', '[{"ref": "x", "heading": "y"}]'::jsonb)
   ->> 'error'),
  'invalid_request', 'a regulator outside the plan-named set is refused');

select pg_temp.assert_eq(
  (select public.publish_regulatory_framework(
     'RBI-NOBODY', 'RBI', 'Ghost publisher', '', 'https://www.rbi.org.in', '2026-09-26', 'v',
     gen_random_uuid(), '[{"ref": "x", "heading": "y"}]'::jsonb)
   ->> 'error'),
  'publisher_not_found', 'publication names a real publisher');

select pg_temp.assert_eq(
  (select public.publish_regulatory_framework(
     'RBI-BADREF', 'RBI', 'Bad refs', '', 'https://www.rbi.org.in', '2026-09-26', 'v',
     '00000000-0000-0000-0000-0000000000b1',
     '[{"ref": "x"}]'::jsonb)
   ->> 'error'),
  'invalid_request', 'a framework control without a heading is refused');

-- ─── Control mappings ────────────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-SEC-001', 'test-w7',
     'partial', 'reference',
     'The MD baseline satisfies much of s.8(5) for a supervised entity; scopes differ.',
     '00000000-0000-0000-0000-0000000000b1')
   -> 'mapping' ->> 'strength'),
  'partial', 'the cross-walk records with its strength');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-SEC-001', 'test-w7',
     'partial', 'reference',
     'The MD baseline satisfies much of s.8(5) for a supervised entity; scopes differ.',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'already_mapped', 'the same cross-walk is refused, not upserted');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-governance-oversight', 'DPDPA-BRCH-001', 'test-w7',
     'equivalent', 'reference', 'An unverified equivalence claim.',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'invalid_request', 'an equivalence claim cannot ride on reference provenance');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'nowhere', 'DPDPA-SEC-001', 'test-w7',
     'indicative', 'reference', 'Points at a ref that does not exist.',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'framework_control_not_found', 'a mapping resolves to a real framework control');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-GOV-999', 'test-w7',
     'indicative', 'reference', 'Points at a control that does not exist.',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'control_not_found', 'a mapping names a real published control');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-SEC-001', 'test-other',
     'indicative', 'reference', 'Version that was never published.',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'library_version_not_found', 'a mapping pins a real library version');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-XBR-001', 'test-w7',
     'indicative', 'vendor-verified', 'Dishonest provenance.',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'invalid_request', 'vendor-verified is refused at the gate');

select pg_temp.assert_eq(
  (select public.record_control_mapping(
     'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-XBR-001', 'test-w7',
     'partial', 'reference', 'Genuine overlap, material differences.',
     '00000000-0000-0000-0000-0000000000b1')
   -> 'mapping' ->> 'provenance'),
  'reference', 'honest provenance records normally');

-- ─── Sector pack publication ─────────────────────────────────────────
select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-1', 'BFSI sector pack #1', 'BFSI',
     'Overlay of the financial-sector regulators onto the DPDPA control set.',
     'test-w7',
     array['DPDPA-SEC-001', 'DPDPA-XBR-001'],
     array['RBI-MD-ITG'],
     '[{"requirement": "Regulator-grade IS audit summary", "evidenceType": "report"}]'::jsonb,
     '[{"pattern": "policy"}]'::jsonb,
     null,
     '00000000-0000-0000-0000-0000000000b1')
   -> 'pack' ->> 'controlsCount'),
  '2', 'the pack publishes with every reference resolved');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-1', 'Duplicate', 'BFSI', '', 'test-w7', array['DPDPA-SEC-001'], array['RBI-MD-ITG'],
     '[]'::jsonb, '[]'::jsonb, null, '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'already_published', 'a pack code publishes once');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-2', 'Wrong sector', 'Fintech', '', 'test-w7', array['DPDPA-SEC-001'],
     array['RBI-MD-ITG'], '[]'::jsonb, '[]'::jsonb, null,
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'invalid_request', 'a sector outside the plan-named set is refused');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-2', 'Phantom control', 'BFSI', '', 'test-w7', array['DPDPA-SEC-999'],
     array['RBI-MD-ITG'], '[]'::jsonb, '[]'::jsonb, null,
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'control_not_found', 'a pack names real controls in the pinned version');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-2', 'Wrong version', 'BFSI', '', 'test-other', array['DPDPA-SEC-001'],
     array['RBI-MD-ITG'], '[]'::jsonb, '[]'::jsonb, null,
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'library_version_not_found', 'a pack pins a real library version');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-2', 'Phantom framework', 'BFSI', '', 'test-w7', array['DPDPA-SEC-001'],
     array['IRDAI-CYBER-SECURITY'], '[]'::jsonb, '[]'::jsonb, null,
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'framework_not_found', 'a pack names published frameworks only');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-2', 'Duplicate subset ids', 'BFSI', '', 'test-w7', array['DPDPA-SEC-001', 'DPDPA-SEC-001'],
     array['RBI-MD-ITG'], '[]'::jsonb, '[]'::jsonb, null,
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'invalid_request', 'the control subset is a set, not a bag');

select pg_temp.assert_eq(
  (select public.publish_sector_pack(
     'BFSI-2', 'Bad hash', 'BFSI', '', 'test-w7', array['DPDPA-SEC-001'], array['RBI-MD-ITG'],
     '[]'::jsonb, '[]'::jsonb, 'not-a-hash',
     '00000000-0000-0000-0000-0000000000b1')
   ->> 'error'),
  'invalid_request', 'a content hash, if given, is a sha256 hex digest');

-- ─── The privilege wall: nobody writes the catalogue directly ────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
-- An authenticated user with no role anywhere still reads the shared rulebook.
select pg_temp.assert_true(
  (select count(*) = 1 from public.frameworks where code = 'RBI-MD-ITG'),
  'any authenticated user reads the framework catalogue');
select pg_temp.assert_true(
  (select count(*) >= 2 from public.control_mappings),
  'any authenticated user reads the cross-walks');
select pg_temp.assert_true(
  (select count(*) = 1 from public.sector_packs where code = 'BFSI-1'),
  'any authenticated user reads the published packs');
select pg_temp.denied($q$insert into public.frameworks(code, regulator, title, source_url, verified_on, verified_by, published_by)
  values ('HACK-1', 'RBI', 'H', 'https://www.rbi.org.in', '2026-09-26', 'v', null)$q$);
select pg_temp.denied($q$insert into public.control_mappings(control_id, library_version, framework_control_id,
  mapping_strength, provenance, note, recorded_by)
  select 'DPDPA-SEC-001', 'test-w7', fc.id, 'equivalent', 'reference', 'x', null
  from public.framework_controls fc
  join public.frameworks f on f.id = fc.framework_id
  where f.code = 'RBI-MD-ITG' and fc.ref = 'it-infosec-controls'$q$);
select pg_temp.denied($q$insert into public.sector_packs(code, name, sector, library_version)
  values ('HACK-1', 'H', 'BFSI', 'test-w7')$q$);
select pg_temp.denied($q$update public.control_mappings set mapping_strength = 'equivalent'$q$);
select pg_temp.denied($q$update public.sector_packs set control_ids = '{DPDPA-BRCH-001}'::text[]$q$);
select pg_temp.denied($q$delete from public.frameworks$q$);
select pg_temp.denied($q$delete from public.control_mappings$q$);
-- Publication is a service path, not a browser path.
select pg_temp.denied($q$select public.publish_regulatory_framework(
  'HACK-1', 'RBI', 'H', '', 'https://www.rbi.org.in', '2026-09-26', 'v', null, '[]'::jsonb)$q$);
select pg_temp.denied($q$select public.record_control_mapping(
  'RBI-MD-ITG', 'it-infosec-controls', 'DPDPA-SEC-001', 'test-w7',
  'partial', 'reference', 'x', null)$q$);
select pg_temp.denied($q$select public.publish_sector_pack(
  'HACK-1', 'H', 'BFSI', '', 'test-w7', array['DPDPA-SEC-001'], array['RBI-MD-ITG'],
  '[]'::jsonb, '[]'::jsonb, null, null)$q$);
reset role;

-- The service role executes the publication paths and reads the catalogue,
-- and still cannot write the tables themselves.
set local role service_role;
select pg_temp.assert_eq(
  (select public.publish_regulatory_framework(
     'SEBI-CYBER-RESILIENCE', 'SEBI',
     'SEBI Cybersecurity and Cyber Resilience Framework for regulated entities',
     'Baseline cyber resilience for SEBI-regulated entities.',
     'https://www.sebi.gov.in', '2026-09-26', 'Axiom Minds · Founder',
     '00000000-0000-0000-0000-0000000000b1',
     '[{"ref": "cyber-resilience-baseline", "heading": "Baseline cyber-security controls"}]'::jsonb)
   -> 'framework' ->> 'regulator'),
  'SEBI', 'the BFF service publishes a framework');
select pg_temp.assert_true(
  (select count(*) >= 2 from public.frameworks), 'the BFF service reads the catalogue');
select pg_temp.denied($q$insert into public.frameworks(code, regulator, title, source_url, verified_on, verified_by, published_by)
  values ('HACK-2', 'RBI', 'H', 'https://www.rbi.org.in', '2026-09-26', 'v', null)$q$);
select pg_temp.denied($q$update public.control_mappings set mapping_strength = 'equivalent'$q$);
select pg_temp.denied($q$delete from public.sector_packs$q$);
select pg_temp.denied($q$update public.framework_controls set heading = 'rewritten'$q$);
reset role;

rollback;
