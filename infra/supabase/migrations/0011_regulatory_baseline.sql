-- ─────────────────────────────────────────────────────────────────────
-- 0011_regulatory_baseline.sql
-- Regulatory baseline and library provenance (W7.0).
--
-- The control library is the definition of what compliance MEANS — the
-- baseline every assessment, finding, penalty estimate and client report
-- is computed against. Until now it had no recorded relationship to the
-- law it implements: one free-text `change_log` column, and no way to
-- answer "which gazette text was this control verified against, by whom,
-- when?".
--
-- That absence is why CTL-1 survived a year. 21 of 24 Rules citations
-- pointed at the draft numbering, every generated report cited the wrong
-- law, and nothing in the schema could have surfaced it.
--
-- Extends 0002_control_library.sql rather than replacing it. The existing
-- model was a good skeleton — immutable publication events, controls keyed
-- (id, library_version), assessments pinning a version — it just stopped
-- one level short of the law itself.
-- ─────────────────────────────────────────────────────────────────────

create type instrument_status as enum (
  'notified',    -- in the Gazette and operative, subject to commencement
  'corrigendum', -- corrects the printed text of another instrument
  'proposed',    -- announced or consulted on — NOT law, excluded from scoring
  'draft',
  'repealed'
);

-- ─── The law itself, as retrieved ────────────────────────────────────
create table public.regulatory_instruments (
  id uuid primary key default gen_random_uuid(),
  jurisdiction text not null default 'IN',
  short_code text not null unique,            -- 'GSR-846E'
  title text not null,
  gazette_ref text not null,                  -- 'G.S.R. 846(E), Gazette No. 760'
  -- The date printed on the Gazette issue, not the date it was reported.
  -- Commencement computes from this, so a day's error moves every deadline.
  published_on date not null,
  effective_from date,
  status instrument_status not null,
  source_url text not null,
  retrieved_at timestamptz not null default now(),
  -- Tamper-evidence for the rulebook, the same model the audit ledger uses
  -- for evidence. A report can state "assessed against baseline X, hash Y"
  -- and a third party can check it.
  content_sha256 text,
  -- The amendment chain.
  amends_id uuid references public.regulatory_instruments(id) on delete restrict,
  supersedes_id uuid references public.regulatory_instruments(id) on delete restrict,
  -- Provenance of the RECORD, distinct from provenance of the instrument.
  verified_on date not null,
  verified_by text not null,
  notes text,
  created_at timestamptz not null default now()
);

comment on table public.regulatory_instruments is
  'Statutory instruments as retrieved, content-hashed, with their amendment chain (W7.0).';

-- ─── Addressable units within an instrument ──────────────────────────
create table public.regulatory_provisions (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.regulatory_instruments(id) on delete cascade,
  provision_ref text not null,                -- 'Rule 7(1)', 'Third Schedule'
  heading text not null,
  -- Commencement is per-provision, not per-instrument: rule 1 of
  -- G.S.R. 846(E) commences rules 1, 2 and 17-21 immediately, rule 4 after
  -- a year, and the rest after eighteen months. A control anchored to a
  -- provision that is not yet in force is a readiness item, not a finding.
  effective_from date,
  text_sha256 text,
  created_at timestamptz not null default now(),
  unique (instrument_id, provision_ref)
);

-- ─── A frozen, named instrument set ──────────────────────────────────
create table public.regulatory_baselines (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                  -- 'IN-DPDP@2026-09-20'
  declared_on date not null,
  declared_by text not null,
  instrument_ids uuid[] not null,
  baseline_sha256 text,
  created_at timestamptz not null default now()
);

-- ─── Extend the existing library table ───────────────────────────────
alter table public.control_libraries
  add column if not exists baseline_id uuid references public.regulatory_baselines(id) on delete restrict,
  add column if not exists semver_major integer,
  add column if not exists semver_minor integer,
  add column if not exists semver_patch integer,
  add column if not exists content_sha256 text,
  add column if not exists supersedes_version text references public.control_libraries(version) on delete restrict,
  add column if not exists status text not null default 'published'
    check (status in ('draft', 'published', 'deprecated'));

comment on column public.control_libraries.semver_major is
  'MAJOR = scoring model, domain taxonomy or control identity changed; assessments are NOT comparable and must be re-run.';
comment on column public.control_libraries.semver_minor is
  'MINOR = controls added/removed/materially reworded, or a new instrument entered the baseline; comparable with deltas shown.';
comment on column public.control_libraries.semver_patch is
  'PATCH = citation corrections, typos, non-substantive corrigenda; what is TESTED does not change, so assessments stay fully valid.';

-- ─── The missing link: control <- provision ──────────────────────────
create table public.control_provenance (
  id uuid primary key default gen_random_uuid(),
  control_id text not null,
  library_version text not null references public.control_libraries(version) on delete cascade,
  provision_id uuid not null references public.regulatory_provisions(id) on delete restrict,
  mapping_type text not null check (mapping_type in ('derives_from', 'supports', 'informational')),
  -- The CTL-1 vaccine. A citation now carries provenance of the SOURCE, not
  -- just the version it appeared in, so a citation never checked against a
  -- notified instrument is visible as such and CI can fail on it.
  verified_on date not null,
  verified_by text not null,
  verification_method text not null,
  note text,
  created_at timestamptz not null default now(),
  foreign key (control_id, library_version)
    references public.controls(id, library_version) on delete cascade,
  unique (control_id, library_version, provision_id)
);

comment on table public.control_provenance is
  'Which gazette provision each control derives from, verified by whom and when. The CTL-1 vaccine (W7.0).';

create index control_provenance_stale_idx
  on public.control_provenance (library_version, verified_on);

-- ─── Typed, per-control diffs between versions ───────────────────────
create table public.control_change_log (
  id uuid primary key default gen_random_uuid(),
  from_version text references public.control_libraries(version) on delete restrict,
  to_version text not null references public.control_libraries(version) on delete cascade,
  control_id text not null,
  -- Change TYPE is what makes the corrigendum tractable: G.S.R. 892(E) DID
  -- amend the Rules, and it must NOT invalidate a single assessment, because
  -- it changed grammar rather than obligation. A free-text changelog cannot
  -- express that distinction; this column can.
  change_type text not null check (change_type in (
    'added', 'removed', 'reworded_material', 'citation_corrected',
    'scoring_changed', 'severity_changed', 'evidence_changed',
    'deprecated', 'superseded_by'
  )),
  rationale text not null,
  source_instrument_id uuid references public.regulatory_instruments(id) on delete set null,
  diff jsonb,
  created_at timestamptz not null default now()
);

create index control_change_log_to_version_idx
  on public.control_change_log (to_version, control_id);

-- ─── Nazar's output, triaged ─────────────────────────────────────────
create table public.regulatory_signals (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  detected_at timestamptz not null default now(),
  retrieved_sha256 text,
  signal_type text not null,
  summary text not null,
  -- Nothing enters the compliance baseline without a human accepting it
  -- (BR-1). SEC-15: Nazar previously held `control_library.write`, which
  -- would have let an L1 agent ingesting untrusted web content rewrite the
  -- definition of compliance for every client. Its correct scope is
  -- `regulatory_signal.write` — it PROPOSES a delta and a human accepts it.
  status text not null default 'new'
    check (status in ('new', 'triaged', 'accepted', 'rejected')),
  proposed_instrument_id uuid references public.regulatory_instruments(id) on delete set null,
  affected_control_ids text[] not null default '{}',
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create index regulatory_signals_status_idx
  on public.regulatory_signals (status, detected_at desc);

-- ─── RLS ─────────────────────────────────────────────────────────────
-- The regulatory baseline is not tenant data: it is the shared rulebook,
-- and every authenticated user needs to read it to understand their own
-- report. Writes are founder/service-role only, per the maker-checker
-- pattern applied to the rulebook itself.
alter table public.regulatory_instruments enable row level security;
alter table public.regulatory_provisions enable row level security;
alter table public.regulatory_baselines enable row level security;
alter table public.control_provenance enable row level security;
alter table public.control_change_log enable row level security;
alter table public.regulatory_signals enable row level security;

create policy regulatory_instruments_read on public.regulatory_instruments
  for select using (auth.role() = 'authenticated');
create policy regulatory_provisions_read on public.regulatory_provisions
  for select using (auth.role() = 'authenticated');
create policy regulatory_baselines_read on public.regulatory_baselines
  for select using (auth.role() = 'authenticated');
create policy control_provenance_read on public.control_provenance
  for select using (auth.role() = 'authenticated');
create policy control_change_log_read on public.control_change_log
  for select using (auth.role() = 'authenticated');

-- Signals are internal triage, not client-facing: a half-reviewed reading
-- of a gazette page is not something to show a client as compliance advice.
create policy regulatory_signals_internal_read on public.regulatory_signals
  for select using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.is_axiom_internal)
  );
