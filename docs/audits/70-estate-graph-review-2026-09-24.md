# Revision 81 — W3.5 entity-relationship graph

## Scope and assumptions

W3.5 is the first-class `/estate/graph` page described in Doc 11. Operator input was not received; the choices below are recorded as assumptions:

1. The graph is built only from rows the signed-in member can already read:
   - active estates and systems;
   - connector registrations that are not archived;
   - declared and observed data categories;
   - active, unrevoked, unexpired `connector_grants`.

   Access edges exist only where such a grant exists. Every agent is always drawn, so an agent with no edge visibly holds no access. Sudhaar has none by construction.

2. Edge styles:
   - containment (estate → system → connector) is dashed grey;
   - "declares" (system → category) is thin grey;
   - read grants are solid teal;
   - write grants are solid indigo with a 🔒 WRITE label.

   Gold is not used; it stays reserved for sealed evidence and attestations.

3. Derivation edges (finding → control, evidence → finding) and live agent-run animation are **not** included in this revision. They need the assessment/evidence projection and the agent-run channel, both of which belong to later work. They are recorded as remaining W3.5 scope rather than drawn from invented data.
4. Export is SVG, serialised from the rendered graph. PNG export and W8 board-pack branding remain open.

## Change

- `apps/web/src/lib/estate-graph.ts` is a pure graph builder with filters by estate, agent and access type, plus a deterministic column layout. It has unit tests.
- `/estate/graph` provides:
  - filters, and a one-click "Everything Karya can write to" view;
  - a node detail panel showing relationships and grant expiry, using the existing `AgentIcon` for agent nodes;
  - SVG export.

  It is linked from `/estate`.

## Verification

| Check                                                                                                                                                                                          | Result                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `estate-graph.test.ts` (inactive or expired grants excluded, agents without edges kept, Karya write view, containment and layout)                                                              | 4/4                      |
| Web typecheck, lint and test                                                                                                                                                                   | pass                     |
| Playwright `estate-graph.spec.ts`: seeded Drishti read and Karya write grants give 1 read edge and 1 write edge; 10 agent nodes; Sudhaar has no relationships; the Karya view shows write only | runs in CI's persona job |
