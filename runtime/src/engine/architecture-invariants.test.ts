// ═══ Architecture ratchet gates — Phase 1 of the 2026-06-09 reckoning ═══
//
// These are NOT behavior tests. They LOCK structural invariants so the known
// debt cannot grow while it is being paid down — the "no enforcement → every
// decomposition regresses to the mean" master-root (reckoning §1.1 R1):
//
//   1. package DAG     — compiler/ must NEVER import @xgis/runtime (the one
//                        genuine structural asset: an acyclic package graph).
//   2. map↔render-loop — render-loop.ts must import ./map TYPE-only, so the
//                        runtime value-import cycle stays broken (commit 605479a5).
//   3. LOC ceilings    — the 15 current god-files (>800 LOC) may only SHRINK;
//                        no NEW source file may cross 800 LOC.
//   4. projType branch — `projType ===/!==` belongs ONLY in projections-table.ts;
//                        the current scattered sites are a frozen allowlist.
//
// A RATCHET: every number below is a high-water mark meant to drop over time,
// never rise. When you shrink a file or delete a projType branch, LOWER the
// baseline here in the same commit. GPU-free; runs in the CI `test` job.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC_DIRS = ['runtime/src', 'compiler/src', 'blueprint/src', 'shared/src']

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
function rel(abs: string): string {
  return relative(ROOT, abs).split('\\').join('/')
}
function lineCount(abs: string): number {
  const s = readFileSync(abs, 'utf8')
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

const ALL_TS = SRC_DIRS.flatMap((d) => walkTs(join(ROOT, d)))

// ── Gate 1: package DAG ──────────────────────────────────────────────
describe('arch ratchet: package DAG (no compiler → runtime cycle)', () => {
  it('compiler/src never imports @xgis/runtime', () => {
    const re = /^\s*import\b[^\n]*from\s+['"](@xgis\/runtime|[^'"]*\/runtime\/src)/m
    const offenders = walkTs(join(ROOT, 'compiler/src'))
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(
      offenders,
      `compiler must not import @xgis/runtime — it would make the package graph cyclic (the one real structural asset):\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ── Gate 2: map ↔ render-loop value-import cycle ─────────────────────
describe('arch ratchet: map ↔ render-loop value-import cycle stays broken', () => {
  it('render-loop.ts imports ./map as `import type` only', () => {
    const s = readFileSync(join(ROOT, 'runtime/src/engine/render-loop.ts'), 'utf8')
    // A VALUE import of ./map re-forms the runtime cycle (map.ts value-imports
    // render-loop.ts). `import type` is erased by tsc, so it does not.
    const valueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]\.\/map['"]/m
    expect(
      valueImport.test(s),
      'render-loop.ts must import ./map with `import type` only (see commit 605479a5) — a value import re-creates the map↔render-loop runtime cycle',
    ).toBe(false)
  })
})

// ── Gate 3: LOC ceilings (god-files shrink-only; no new god-files) ───
// High-water marks measured 2026-06-09. LOWER these as files shrink.
const LOC_CEILINGS: Record<string, number> = {
  // Bumped 3913→3924 for the sync-path (doUploadTile) line/outline/segment
  // buffer-leak fix: the 5 buffer declarations are hoisted ABOVE the try so
  // the catch backstop can reach them, and 5 cleanup statements (release the
  // pooled line/index buffers + destroy the lineRenderer-owned segment
  // buffers) mirror doUploadTileAsync's cleanupLineBuffers. Irreducible — the
  // async path already carries the identical structure; this closes the
  // asymmetric sync gap (throw before layerCache.set → leaked VRAM).
  // Bumped 3924→3934 for the bundle-cache compaction-UAF fix: capturing
  // runFrameMaintenance's new "compacted" return + invalidating every cached
  // render bundle (whose recorded buffer ref the arena swap retired) is
  // irreducible — the explanatory comment carries the bulk (mirrors the
  // async-upload buffer-identity guard; latent since bundles are default-OFF).
  'runtime/src/engine/render/vector-tile-renderer.ts': 3934,
  // Bumped 3361→3393 for the destroy()-completeness fix: cancelling the
  // EventDispatcher move-rAF + the pending-flush rAF, clearing _pendingPatches,
  // and removing the run()-installed window globals (__xgisReady/snapshot/
  // replay/trace) are irreducible teardown statements. map.ts decomposition
  // remains a tracked priority; shrink as the destroy body is extracted.
  // Bumped 3393→3412 for the updateFeature() tile-backed silent-drop fix:
  // a `{_vectorTile}`/`{_tileUrl}` marker passed the rawDatasets.has()
  // precondition, queued a patch that flush then discarded with no warn. The
  // `_tileBackedUpdateWarned` Set + the enqueue-time guard + the defensive
  // flush-time warn are irreducible (warn-once data-loss prevention).
  'runtime/src/engine/map.ts': 3412,
  // Bumped 1343→1344 for the opacity sub-1.5% round-trip fix (#274); comments
  // trimmed to the minimum, net +1 irreducible.
  'compiler/src/ir/lower.ts': 1344,
  'runtime/src/engine/text/text-stage.ts': 1441,
  'compiler/src/tiler/vector-tiler.ts': 1509,
  'runtime/src/engine/render/renderer.ts': 915,
  'compiler/src/convert/layers.ts': 1539,
  'compiler/src/convert/expressions.ts': 1534,
  'runtime/src/data/tile-catalog.ts': 1388,
  // Bumped 1353→1354 for the load() history.reset() fix (#270): one
  // irreducible statement (undo-after-import correctness).
  'blueprint/src/editor.ts': 1354,
  'runtime/src/engine/shader-dsl/shaders/line.ts': 1187,
  // Bumped 1171→1176 for the CSS color-fn whitespace fix (#274): the
  // separator-insertion logic in captureFnCallAsString is irreducible (comment
  // already trimmed). parser.ts decomposition remains a tracked priority.
  'compiler/src/parser/parser.ts': 1176,
  'runtime/src/engine/shader-dsl/shaders/polygon.ts': 1139,
  // Bumped 1067→1092 for the minZoom + setMaxBounds gesture-clamp correctness
  // fixes (#244/#248): the maxBounds clamp method + its 7 gesture-exit call
  // sites are irreducible. camera.ts decomposition remains a tracked priority.
  'runtime/src/engine/projection/camera.ts': 1092,
  // Bumped 1065→1067 for the curved-text early-return perf-mark balance fix:
  // the `total < spacingPx*0.5` curved branch was missing the two matching
  // perfMarkEnd('…line.emit')/('…line.polyline') calls its sibling returns
  // already make (lines ~867/889/906) — two irreducible balanced-mark lines.
  'runtime/src/engine/render/passes/label-pass.ts': 1067,
  // VTR Unit-1 extraction (Cluster E-selection). The hysteresis +
  // readiness-gate logic was moved VERBATIM (plan §5 DO-NOT-SPLIT #2),
  // and its hard-won fix-history comments carry the bulk of the LOC —
  // just over the 800 cap. Baselined here; shrink as comments distil.
  'runtime/src/engine/render/tile-selection-cache.ts': 858,
  // renderer.ts Unit-1 extraction (PipelineFactory) — the pipeline /
  // bind-group-layout / atlas-stub construction + the three per-variant
  // builders (createVariantPipelines + createVariantPipelinesAsync +
  // buildVariantDescriptors, each a near-identical descriptor set) were
  // moved VERBATIM (rasterization-critical, CI has no GPU; plan §2 Unit 1).
  // Over the 800 cap because the verbatim descriptor sets + hard-won
  // fix-history comments (OIT cull, iter-130/186/197 etc.) carry the LOC.
  // Baselined here; shrink as the three builders converge (descriptor
  // factory) + comments distil.
  'runtime/src/engine/render/pipeline-factory.ts': 1193,
}
const NEW_FILE_CAP = 800

describe('arch ratchet: file size (shrink-only god-files, no new ones)', () => {
  it('no baselined god-file exceeds its locked ceiling', () => {
    const grown = Object.entries(LOC_CEILINGS)
      .map(([path, ceil]) => ({ path, n: lineCount(join(ROOT, path)), ceil }))
      .filter((x) => x.n > x.ceil)
      .map((x) => `${x.path}: ${x.n} > ceiling ${x.ceil} — extract, don't grow (then lower the ceiling)`)
    expect(grown, grown.join('\n')).toEqual([])
  })

  it(`no non-baselined source file exceeds ${NEW_FILE_CAP} LOC`, () => {
    const tooBig = ALL_TS
      .filter((f) => !(rel(f) in LOC_CEILINGS))
      .map((f) => ({ r: rel(f), n: lineCount(f) }))
      .filter((x) => x.n > NEW_FILE_CAP)
      .map((x) => `${x.r}: ${x.n} > ${NEW_FILE_CAP} — split it before it becomes a god-file`)
    expect(tooBig, tooBig.join('\n')).toEqual([])
  })
})

// ── Gate 4: projType branching confined to projections-table ─────────
// Occurrence counts of `projType ===/!==` outside projections-table.ts,
// frozen 2026-06-09. LOWER these as branches are routed through exported
// membership accessors (isCylindrical / isFlat / isOrtho / …).
const PROJTYPE_ALLOWLIST: Record<string, number> = {
  'runtime/src/engine/projection/camera.ts': 7,
  'runtime/src/engine/controller.ts': 6,
  'runtime/src/engine/projection/unproject.ts': 4,
  'runtime/src/loader/tiles-sse.ts': 3,
  'runtime/src/engine/render/raster-renderer.ts': 2,
  'runtime/src/engine/render/prefetch-scheduler.ts': 1,
  'runtime/src/engine/render/point-renderer.ts': 1,
  'runtime/src/data/tile-select.ts': 1,
}

describe('arch ratchet: projType branching confined to projections-table', () => {
  it('no source file exceeds its allowed projType-comparison count', () => {
    const violations: string[] = []
    for (const f of ALL_TS) {
      const r = rel(f)
      if (r.endsWith('projection/projections-table.ts')) continue
      const count = (readFileSync(f, 'utf8').match(/projType\s*[!=]==/g) || []).length
      const allowed = PROJTYPE_ALLOWLIST[r] ?? 0
      if (count > allowed) {
        violations.push(`${r}: ${count} projType comparisons > allowed ${allowed} — route through projections-table membership accessors`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
