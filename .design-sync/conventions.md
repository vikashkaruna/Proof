# Building with the Axiom Proof UI library

## Setup

- Link `styles.css`. It carries the design tokens, the Tailwind utilities listed below and the brand fonts (Inter Tight for headings, Inter for body, JetBrains Mono for ids and hashes). No provider or theme wrapper is needed: the components are plain React.
- Take components from the `AxiomUI` global (`const { Button, Card, PageHeader } = AxiomUI`).

## Styling idiom: Tailwind utility classes on the Axiom palette

Only these utility families are compiled, so use them for your own layout around the components:

- **Colour**: `bg-`, `text-`, `border-` + `indigo | teal | gold | ember | slate | mist` + a step `50`-`900` (for example `bg-indigo-500`, `text-slate-500`, `border-slate-200`), plus `bg-white`. Indigo is the brand and institutional trust; teal is active machine intelligence and approvals; ember is gaps, risks and overdue; slate and mist are neutrals. **Gold is reserved for sealed evidence and attestations (`Badge variant="proof"`, `ProofSeal`): never use it decoratively.**
- **Layout and spacing**: `flex`, `flex-col`, `flex-wrap`, `grid`, `grid-cols-1..12` (with `sm:`, `md:`, `lg:`), `items-*`, `justify-*`, `p-/px-/py-/m-/gap-/space-y-` on the scale 0-24, `w-/h-` fractions and common sizes, `max-w-xs`..`max-w-6xl`.
- **Type**: `text-xs`..`text-4xl`, `font-heading`, `font-mono`, `font-medium|semibold|bold`, `uppercase`, `tracking-wide`.
- **Shape**: `rounded`, `rounded-lg|xl|2xl|full`, `border`, `shadow-sm|md|lg`.
- CSS variables for anything else: `var(--axiom-color-primary)`, `--axiom-color-accent`, `--axiom-color-proof`, `--axiom-color-alert`, `--axiom-color-fg`, `--axiom-color-fg-muted`, `--axiom-color-border`, `--axiom-color-surface`, `--axiom-color-bg`.

## Product rules the components encode

- **Page header**: use `PageHeader` with `module={{ crumb, titleHi, phase, moduleId, agents }}` for the breadcrumb, Hindi name, phase tag (`P0`-`P5`), module id and the related-agents strip. The strip names agents only.
- **Agent identity**: show an agent as `AgentLabel` (icon, then name). It is static by default; animate (`state="thinking"` or `"working"`) only when a run is really in progress, never as decoration. Never label an agent online or healthy.
- **Empty panels**: use `DataPlaceholder` ("Data yet to be populated"). Never put sample numbers where live data belongs.
- Agents propose; nothing changes without a recorded human approval: approval screens always show the dry-run, rollback and scope before an approve action.

## Where to read more

Per-component props are in `components/<group>/<Name>/<Name>.d.ts` and usage in `<Name>.prompt.md`; the tokens and utilities are in `styles.css`.

## A page, end to end

```jsx
const {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  AgentLabel,
  DataPlaceholder,
} = AxiomUI;

<main className="mx-auto max-w-5xl space-y-6 p-6">
  <PageHeader
    title="Approval queue"
    description="Recorded actions awaiting human review."
    module={{
      crumb: 'Remediate',
      titleHi: 'अनुमोदन कंसोल',
      phase: 'P3',
      moduleId: 'M3.3',
      agents: ['sudhaar', 'karya'],
    }}
  />
  <Card>
    <CardHeader>
      <CardTitle>Retention and erasure remediation</CardTitle>
      <CardDescription>Open the plan to inspect the dry-run and rollback.</CardDescription>
    </CardHeader>
    <CardContent className="flex items-center gap-3">
      <AgentLabel agent="sudhaar" size="xs" />
      <Badge variant="warning">Awaiting approval</Badge>
    </CardContent>
  </Card>
  <DataPlaceholder description="No evidence has been recorded for this plan yet." />
</main>;
```
