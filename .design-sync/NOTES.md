# design-sync notes — @xgis/site

Repo-specific gotchas for future syncs. Read this before re-running.

## What is synced, and why so little

X-GIS is a 3D globe engine monorepo, not a component library. The only React UI surface in
the repo is `site/src/components/ui/` — the three shadcn primitives `Badge`, `Button`,
`Card`. Everything else under `site/src/components/` is `.astro` (not bundlable as React)
or page-specific app code. The real value of this sync is the **token + font + utility
layer**, which the three components carry along.

## Setup quirks (all of these will bite again on a fresh clone)

- **`@xgis/site` has no self-link.** Bun's workspace install does not create
  `site/node_modules/@xgis/site`, and `lib/dts.mjs` reads `<node_modules>/<pkg>/package.json`
  directly, so the build dies with `ENOENT … @xgis/site/package.json`. Recreate it:
  `cmd //c "mklink /J site\node_modules\@xgis\site D:\X-GIS\site"` (Windows junction — no
  admin needed; on POSIX `ln -s ../../.. site/node_modules/@xgis/site`).
- **`--node-modules site/node_modules`**, not the repo root — the root has no `react`
  (bun hoists into `node_modules/.bun/`), the site package's own dir has the links.
- **No `dist/`.** `site` is an Astro app, so the converter runs in synth-entry mode
  (`[NO_DIST]`, "synthesizing from 6 src files"). This is expected, not a failure.
  `Hero`/`GlobeDemo`/`Playground` are default exports, so `export *` never picks them up —
  they stay out of `window.XGis` on their own. They are also `null`ed in `componentSrcMap`
  so they never become cards.
- **Card subparts stay in the bundle.** `CardHeader`/`CardTitle`/`CardDescription`/
  `CardContent`/`CardFooter` are `null` in `componentSrcMap` (no separate card each — that
  would be eight near-identical divs in the pane), but they remain exported from
  `_ds_bundle.js`. Verified: `window.XGis` has 10 exports. Don't "fix" this.

## The CSS is compiled, not copied

`site/src/styles/global.css` is a **Tailwind v4 source** (`@import 'tailwindcss'`), not CSS.
It must be compiled before the converter can ship it:

```sh
node .ds-sync/node_modules/@tailwindcss/cli/dist/index.mjs \
  -i .design-sync/tailwind-entry.css -o site/.design-sync-build/global.compiled.css
```

- `.design-sync/tailwind-entry.css` is committed and is **not** a second source of truth —
  it only imports `global.css` and adds `@source` scan scope + a safelist.
- Output must live **inside `site/`**: `cfg.cssEntry` is bounded to the package dir
  (`PKG_DIR`), so a `../.design-sync/...` path is silently skipped with
  `! cssEntry: … not found`. `site/.design-sync-build/` is gitignored.
- **The safelist is load-bearing.** Tailwind only emits utilities it finds in scanned
  source, but the design agent writes classes this repo never wrote. Without
  `@source inline(...)` for the token families, six documented utilities
  (`bg-popover`, `text-popover-foreground`, `bg-muted`, `ring-ring`, `rounded-sm`,
  `font-sans`) compiled away and `conventions.md` would have been lying. `conventions.md`
  and `previews/*.tsx` are also in the scan scope for the same reason.

## Dark-canvas DS vs. the preview harness

`lib/emit.mjs` hardcodes `body{…;background:#fff}` in every preview card, with no config
knob. This DS is white-ink-on-near-black, so on that white ground the `primary` swatch
(pure white) renders invisible — the first capture showed empty outlines. Fix, applied in
all three previews: each export wraps its content in
`bg-background text-foreground rounded-lg p-8`. That is also what `conventions.md` tells the
design agent to do at its root, so preview and guidance agree.

## Known render warns (checked every re-sync — anything else is new)

- `[FONT_MISSING] "Inter", "Geist Mono", "JetBrains Mono"` — **legitimate, do not chase.**
  The shipped `@font-face` families are `Inter Variable` and `Geist Mono Variable`, which
  are the _first_ entry of `--font-sans` / `--font-mono`. The warned names are the
  downstream fallbacks in those stacks and were never meant to ship.

## Cosmetic-only

- The editor flags `Cannot find module '@xgis/site'` / `JSX.IntrinsicElements` in
  `.design-sync/previews/*.tsx`. Those files are in no `tsconfig` and are compiled by
  esbuild (no typecheck), so the build is unaffected. Left alone deliberately; add a
  `tsconfig.json` under `previews/` if the squiggles become annoying.

## Re-sync risks — what can go stale

- **The compiled CSS is a build artifact that nothing regenerates automatically.** Edit
  `site/src/styles/global.css` and the sync ships the OLD compiled file unless the Tailwind
  command above is re-run first. Always recompile before `resync.mjs`.
- **The safelist enumerates token names by hand.** Add a token to `global.css`'s `@theme`
  blocks and it will not appear in the uploaded CSS until it is also added to
  `tailwind-entry.css`'s `@source inline(...)` — and `conventions.md` will not mention it.
  Re-validate the conventions header against the fresh build on every sync.
- **`conventions.md` names classes, variants, and exports.** Rename a `cva` variant in
  `badge.tsx`/`button.tsx` and the header goes stale silently. Re-check it, don't rewrite it.
- **The `@xgis/site` junction is gitignored** (it lives in `node_modules`), so a fresh
  clone must recreate it before the first build.
- **Toolchain assumed:** node 24, `@tailwindcss/cli@4.3.2` (matched to the repo's
  `tailwindcss@4.3.2`), `playwright@1.60.0` (pins `chromium-1223`, already in the local
  `%LOCALAPPDATA%\ms-playwright` cache — no 200MB download needed). A different playwright
  fails with `browserType.launch: Executable doesn't exist`.
- **Only three components are in scope.** If `site/src/components/ui/` gains more shadcn
  primitives they are picked up automatically; if the Astro `kit/` is ever ported to React,
  revisit `componentSrcMap`.
