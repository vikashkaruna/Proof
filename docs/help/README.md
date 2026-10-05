# Axiom Proof help manuals

These are audience-specific product manuals, separate from the four living
engineering plan/progress/architecture/operator documents. Read the manual
for the selected release and role; documentation does not grant permissions.

| Audience                   | Manual                                                                                 | Distribution                                                            |
| -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Founder / internal owner   | Protected `.axiom-runtime/help-private/founder.md`                                     | Internal only; never commit or publish                                  |
| Partner / channel partner  | [Partner manual](external/partner.md)                                                  | Reviewed partner audience                                               |
| Client organization roles  | [Client manual](external/client.md)                                                    | Reviewed client audience                                                |
| Internal acceptance tester | Protected `.axiom-runtime/help-private/manual-testing.md` and `manual-test-cases.json` | Internal only; cases are specifications, not passing execution evidence |

**The repository is public.** A directory named “internal” in this repository
would not provide confidentiality. Private manuals live in ignored storage
with directory mode 0700 and file mode 0600. They are not served from the
application or bundled into customer artifacts. Preserve them in an
operator-controlled private backup/vault when moving hosts or worktrees;
Git cannot recover an ignored manual. Do not attach that backup to a PR.

## Manual test scope and results

The protected QA catalogue has **243 cases**, covering **49 route variants**:
39 Web pages, the Pramaan query tab and nine marketing pages. Every route has
separate positive, access/boundary and recovery/validation/UX cases. It also
covers all 49 roadmap modules plus Delivery Playbook M1.8, all 12 agents,
eight B.10 acceptance scenarios, 12 NFRs and cross-module journeys.

Each case records personas, requirement references, release/prerequisites,
steps, expected results, evidence and whether it includes a destructive probe.
The initial execution ledger is entirely **not_run**. Current/staged/candidate/
conditional/blocked availability is a prerequisite classification, not a test
result. Execute eligible cases on an exact approved target and append dated
private results; do not overwrite this initial catalogue or historical evidence.

## What updates automatically

`scripts/help-manuals.py` reads current page routes, navigation and the role
matrix. `sync` regenerates the navigation and action reference in each manual,
checks route/test-case coverage, records reviewed source and document hashes,
and publishes only a sanitized case-ID/route/readiness coverage receipt.
Fictional sample-screen SVGs explain common navigation without real accounts,
tenant data, screenshots, environment values or infrastructure.

CI automatically checks changes in Web/marketing screens, backend/runtime,
shared roles/contracts, controls, configuration, evidence/approval behavior,
migrations, deployment entrypoints and illustrations. A source change that
has not received documentation review fails the help job. Public CI can verify
the private-review receipt, but cannot inspect ignored internal prose; the
maintainer must also run the private check locally.

Automatic extraction cannot safely invent workflow explanations or verify a
manual journey. Related prose, availability, test steps/expected results and
illustrations require review whenever behavior changes. A no-user-visible-change
decision needs a meaningful recorded reason. Do not silence the gate by
updating hashes without reviewing the affected manuals.

## Update with a feature or configuration change

1. Identify changed tasks, permissions, screens, labels, messages and release
   availability. Update the affected external manual and private founder/QA
   instructions; add manual cases for new routes/modules and regression cases
   for changed behavior. Preserve historical test results.
2. Keep external text limited to user tasks/navigation and product concepts.
   Exclude confidential architecture, internal mechanisms, endpoints, keys,
   configuration commands and private record identities. Review illustrations
   using fictional data. Do not place internal prose in tracked help files.
3. Format edited Markdown/JSON, then regenerate with an honest review reason:

   ```bash
   python3 scripts/help-manuals.py sync --review-reason "Reviewed changed invitation steps and role boundaries"
   pnpm exec prettier --write docs/help
   pnpm exec prettier --ignore-path /dev/null --write .axiom-runtime/help-private/founder.md .axiom-runtime/help-private/manual-testing.md .axiom-runtime/help-private/manual-test-cases.json
   python3 scripts/help-manuals.py sync --review-reason "Reviewed changed invitation steps and role boundaries"
   python3 scripts/help-manuals.py check --require-private
   python3 -m unittest discover -s tests/scripts -p test_help_manuals.py
   ```

   The second sync records post-format hashes. Generated reference comparison
   tolerates table padding. Format tracked files again if your formatter
   changes generated JSON; rerun check before committing.

4. Commit only public-safe manuals, illustrations, maintenance receipts and
   tooling. `git status` must not list private manuals, results or credentials.
   Keep the four living documents updated for the milestone.
5. CI rechecks freshness and emits **only** the two approved external HTML
   artifacts. It does not deploy them or send them to partners/clients.

## Build shareable offline manuals

Use a fresh empty output directory for each reviewed artifact:

```bash
python3 scripts/help-manuals.py export --audience client --output .axiom-runtime/help-share/client-review
python3 scripts/help-manuals.py export --audience partner --output .axiom-runtime/help-share/partner-review
```

Each standalone HTML file embeds its approved fictional illustrations, needs
no CDN or scripts, works offline and supports browser Print / Save as PDF.
Product navigation links open the product's public address. Review the exact
output before sharing. The sharing command refuses founder/QA audiences,
unapproved links/assets, active illustrations, stale docs and internal content
markers. These guards support editorial confidentiality review; they are not
a promise that keyword scanning can detect every possible confidential fact.

For internal use open the protected Markdown manuals directly. No external
export of the founder manual is provided. No in-app public help route or
unauthorized external distribution is introduced by this documentation work.
