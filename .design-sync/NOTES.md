# design-sync notes for @axiom/ui

## How to run

- Build the library first: `pnpm --filter @axiom/ui build` (esbuild JS, tsc declarations, Tailwind stylesheet into `packages/ui/dist/`). `package.json` `main`/`exports` still point at `src/`, so the converter is given the entry explicitly: `--entry packages/ui/dist/index.js --node-modules packages/ui/node_modules`.
- `.design-sync/config.json` paths (`tsconfig`, `cssEntry`) are relative to the package (`packages/ui`), not the repo root.
- Stage the converter into `.ds-sync/` (gitignored) and install `esbuild ts-morph @types/react playwright@1.63.0` there; the render check reuses the Playwright browser cache of the repo's pinned version.
- Previews live in `.design-sync/previews/<Name>.tsx` (committed, hand-authored). `ds-bundle/` is build output (gitignored).

## Gotchas found

- The converter drops any export whose name ends in `Context`, `Manager` or `Placements` (it assumes a React context). `ModuleContext` was renamed `ModuleBar` for that reason; avoid such names for new components.
- `@axiom/ui` is Tailwind-based and `dist/ui.css` only contains utilities the components use, so `packages/ui/tailwind.config.ts` has a safelist of everyday layout, spacing, type and colour utilities. If the conventions header lists a utility, check it exists in `dist/ui.css`.
- The brand preset replaces Tailwind's palette; red, green, amber, emerald, yellow, orange, blue and rose were missing and have been added (`packages/design-tokens/src/tailwind.ts`, guarded by `palette-coverage.test.ts`). Warnings use amber; gold is only for sealed evidence.
- Fonts (Inter Tight, Inter, JetBrains Mono) are not in the repo: the web app uses `next/font`. `packages/ui/src/styles.css` imports them from Google Fonts, so the validate line `[FONT_REMOTE]` is expected.
- Previews: `AgentRunCard` needs width >= 560 or the agent pill wraps; `StatGrid` uses `lg:grid-cols-4`, so keep its preview width <= 640 or it clips; capture sheets render tall with empty space (capture frame height, not a preview problem). Card parts must be previewed inside a `Card` with a header (a `CardContent`-only card has no top padding).
- Animated agent states (`thinking`, `working`) cannot be told apart from `idle` in a still screenshot; those cells are graded on captions and layout.
- On macOS `sed -i` needs an empty-string argument; prefer python or perl for scripted edits.

## Re-sync risks

- The Google Fonts `@import` is fetched at render time; an offline or blocked environment renders fallback fonts.
- Previews carry illustrative example content (labelled as such) and fixed widths; they are not tied to app data, but they are tied to component props, so a prop rename needs a preview update.
- The safelist is a curated list, not derived from usage: new utility families used by components are picked up automatically, but design-agent glue code may want families outside it.
- The animated agent states were not verified visually (see above).
- Converter heuristics: `[CSS_RUNTIME]` and the name filter above; `grep ASSUMPTION .ds-sync/lib/*.mjs` lists the overridable ones.
