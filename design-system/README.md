# Axiom Proof — Design System

The design prototype is a visual reference for the production token and UI
packages in `../packages/design-tokens/` and `../packages/ui/`. Neither app
should hand-roll its own palette or type scale.

## What's here

- `Axiom Proof Design System.dc.html` — open in a browser (self-contained with `support.js`). Documents:
  - **Colour** — Deep Indigo `#1E2A4A` (primary), Signal Teal `#0FB5A5` (accent/CTA), Seal Gold `#C9A227` (**reserved exclusively** for sealed evidence / verified badges — never decorative), Ember `#D9534F` (alerts/risk), Slate `#2F3542` (body text), Mist `#F4F6F8` (backgrounds).
  - **Type** — Inter Tight (headings), Inter (body), JetBrains Mono (hashes, logs, audit trails).
  - **Components** — buttons, risk/status badges, phase tags, evidence-seal treatment.
  - **Agent identity system** — mark, colour, Devanagari initial, autonomy ceiling, and persona line for each of the 12 agents (Drishti, Vibhaag, Parikshan, Saakshi, Sudhaar, Karya, Lekha, Nazar, Prativedan, Sanket, Samadhan, Pramaan).
  - **Voice & tone** — words to use / avoid, and the critical brand rule: _never market autonomy without control_ — every agentic claim must pair the capability with the approval gate.

## On `/design-sync`

The `/design-sync` skill converts a **built component library** (an npm package or Storybook with a `dist/`) into Claude Design's bundle format and uploads it, so the Claude Design agent designs with your real compiled components. The production component code now lives in `../packages/ui/`; this folder remains the visual/token reference.

The production implementation is now available:

1. Update `packages/design-tokens/` and `packages/ui/` when the shared visual
   system changes.
2. Keep this prototype synchronized as a reference; use the design-sync flow
   only when a compiled component package needs to be reflected in the design
   artifact.

## Reference

Brand rationale, positioning, and full GTM detail: [`../docs/01_Product_Naming_Branding_and_GTM.md`](../docs/01_Product_Naming_Branding_and_GTM.md).
