#!/usr/bin/env bun
// ═══ Closed-set shader bake — the driver (#1678 phase A of #1484) ═══
//
//   bun run build                   (from the REPO ROOT — first, see below)
//   bun run bake:shaders            (from map/)
//   bun run bake:shaders --report   (…and print the per-file size table)
//
// THE BUILD IS NOT OPTIONAL (#1865). `map/tsconfig.json`'s `paths` maps
// `@xgis/shader-dsl` to `../shader-dsl/dist/index.d.ts` — it exists for tsc's
// dep-ordered project build — and bun honours tsconfig `paths` at RUNTIME, so this
// script emits through `dist`, never the package's own `exports` (which point at
// `src`). Bake without building after a DSL edit and it exits 0, rewrites all six
// files, and writes byte-identical STALE content; `baked-sync.test.ts` then stays
// red pointing back at this command.
//
// Emits every key in `map/src/shaders/baked/registry.ts` and rewrites the SIX committed
// artifacts — one per (language, group): `baked-{glsl,wgsl}-{hillshade,boot,lazy}
// .generated.ts`. The split is what lets a boot download only the groups it will read;
// which group a family lands in is `FAMILY_GROUPS` in `map/src/shaders/baked/ids.ts`.
//
// `--report` measures what was just written — keys, distinct sources, raw and gzip bytes
// per file, and the hillshade+boot vs +lazy comparison #1679 increment 9 decides on.
// `Bun.gzipSync` is the reason the measurement is taken HERE and the formatting lives in
// `bake.ts`: node's zlib is not what this script runs on, and the report must not become
// a second place that knows the artifact layout.
//
// DELIBERATELY THIN. `map/scripts/` sits outside map's tsconfig `include` (rootDir is
// `src`), so nothing here is typechecked by `tsc --build` — the repo's typecheck
// authority. Everything that could be wrong therefore lives under map/src, where the
// build checks it and `baked-sync.test.ts` can import it; this file only configures
// the host seams, calls the two functions, writes, and formats.
//
// NOT part of `bun run build`, on purpose: the CI test legs run `bun run build` BEFORE
// vitest, and a bake wired into the build would regenerate the artifact it is about to
// be gated against — the gate would then be green by construction and prove nothing.
// The artifact is COMMITTED; this script is how a human refreshes it.
//
// The host seams (configureProjections, then applyBodyOption — the XGISMap constructor's
// order), the (language, group) walk and the module text are `renderAllBakedModules` in
// `map/src/shaders/baked/bake-all.ts`: ONE authority, shared with the dev-server plugin
// (`playground/dev/bake-shaders-on-edit.ts`, #2535) that re-bakes on every shader edit
// while `bun run dev` is up. This script is the no-dev-server path, and the only one that
// needs the build above.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { bakedReportRow, formatBakedReport, type BakedReportRow } from '../src/shaders/baked/bake'
import { renderAllBakedModules } from '../src/shaders/baked/bake-all'

// The seams, the key walk and the module text are `renderAllBakedModules` — ONE authority,
// shared with the dev-server plugin (#2535). This script only writes and formats.
const written = renderAllBakedModules().map((m) => {
  const path = fileURLToPath(new URL(`../src/shaders/baked/${m.file}`, import.meta.url))
  writeFileSync(path, m.text)
  console.log(
    `${m.file}: ${Object.keys(m.artifact.index).length} keys → ` +
      `${Object.keys(m.artifact.contents).length} distinct sources`,
  )
  return { ...m, path }
})
const paths = written.map((w) => w.path)

// Format through the REPO ROOT's prettier so the committed bytes are already canonical.
// Without this the lint-staged pre-commit hook rewrites the generated files on the way
// in, and the NEXT bake would then produce a diff against its own output — the generator
// has to agree with the formatter, not race it.
//
// The root binary by path, not `bunx prettier`: prettier is declared in the ROOT manifest
// (which is also where `format` / `changelog` run it) and in no package manifest, so
// `bunx` would either resolve it by hoisting — an undeclared dependency of map/, knip's
// `unlisted` class — or silently fetch it from the registry, making a build step depend on
// the network. Spelling the root path is the same convention the repo's own commands use
// (`./node_modules/.bin/vitest`).
execFileSync(
  fileURLToPath(new URL('../../node_modules/.bin/prettier', import.meta.url)),
  ['--write', ...paths],
  { stdio: 'inherit' },
)

// --report measures the files as they now sit on disk — i.e. AFTER prettier, which is the
// state that gets committed and bundled. Measuring the pre-format string would report a
// size nothing ever has.
if (process.argv.includes('--report')) {
  const rows: BakedReportRow[] = written.map(({ language, group, path, artifact }) =>
    bakedReportRow(language, group, artifact, readFileSync(path, 'utf8'), Bun.gzipSync),
  )
  console.log(`\n${formatBakedReport(rows)}`)
}
