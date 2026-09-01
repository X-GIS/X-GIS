// ═══ Teardown-reachability ratchet + the documented page-tier list (#2266) ═══
//
// The ownership audit (docs/research/2026-09-01-data-ownership-audit.md)
// grep-verified a teardown caller for every zero-arg lifecycle method in the
// repo — and found the class this ratchet now guards against: destroys nobody
// calls (`GPUTimer.dispose`, `FrameUniform.destroy` — dead APIs whose comment
// contracts had drifted from reality) and teardown that "rests on an
// unenforced reachability invariant" (#1404's own words). Nothing kept that
// audit true: a new `destroy()` with no caller, or a teardown call refactored
// away, landed silently.
//
// Mechanism: scan prod sources for ZERO-ARG teardown-method declarations
// (`destroy()/dispose()/destroyAll()/destroyGpu()/detach()` — parameterized
// per-resource ops like `releaseTile(key)` are deliberately out of scope) and
// require every (file, method) to hold a row here that is one of:
//   via  — a caller anchor: a prod file + substring that must still match
//          (the audit-verified reachability edge, checked on every run);
//   tier — an explicit lifetime class with no caller:
//            'page'     deliberate page-lifetime (shared singletons;
//                       dispose exists for tests — audit D-2),
//            'dormant'  documented dead API pending an audit phase
//                       (delete or adopt),
//            'api-root' the public teardown entry the HOST calls.
// Freshness is asserted BOTH ways (§12 path-keyed-gate lesson): a row whose
// declaration or caller anchor no longer resolves reddens the gate — no
// vacuously-green stale keys. The checker is a pure function, proven
// non-vacuous below on synthetic violating inputs.
//
// A `via` anchor asserts "the audited caller still exists", not whole-graph
// reachability — the right cost/benefit for a ratchet (the audit established
// the edges; this keeps them from rotting silently).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = new URL('../..', import.meta.url).pathname
const SCAN_ROOTS = [
  'map/src',
  'engine/src',
  'data/src',
  'rhi-webgpu/src',
  'rhi-webgl2/src',
  'geo/src',
  'shared/src',
]

const METHODS = ['destroy', 'dispose', 'destroyAll', 'destroyGpu', 'detach'] as const
type LifecycleMethod = (typeof METHODS)[number]

interface Row {
  file: string
  method: LifecycleMethod
  /** Caller anchor: `pattern` must appear verbatim in `file`'s source. */
  via?: { file: string; pattern: string }
  tier?: 'page' | 'dormant' | 'api-root'
}

/** THE documented lifecycle table. Adding a teardown method = adding a row —
 *  either name its caller or consciously class it. That diff IS the record
 *  that the lifetime story was decided, not defaulted. */
const TABLE: Row[] = [
  // ── data ──
  {
    file: 'data/src/sources/pmtiles-backend.ts',
    method: 'detach',
    via: { file: 'data/src/tile-catalog.ts', pattern: 'backend.detach?.()' },
  },
  {
    file: 'data/src/sources/virtual-pmtiles-backend.ts',
    method: 'detach',
    via: { file: 'data/src/tile-catalog.ts', pattern: 'backend.detach?.()' },
  },
  {
    file: 'data/src/tile-catalog.ts',
    method: 'destroy',
    via: { file: 'map/src/map-teardown.ts', pattern: 'source.destroy()' },
  },
  // Shared cross-map singletons: page lifetime is the DOCUMENTED intent
  // (map.ts: "intentionally NOT terminated — a sibling map may still be using
  // it"); dispose() exists for tests. Audit D-2 tracks a last-map protocol.
  { file: 'data/src/workers/geojson-compile-pool.ts', method: 'dispose', tier: 'page' },
  { file: 'data/src/workers/mvt-worker-pool.ts', method: 'dispose', tier: 'page' },
  // ── engine ──
  {
    file: 'engine/src/gpu/gpu-arena.ts',
    method: 'destroy',
    via: { file: 'map/src/render/gpu-tile-store.ts', pattern: 'polyVertexArena?.destroy()' },
  },
  {
    file: 'engine/src/render/material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/material/point-material.ts', pattern: 'this.material.destroy()' },
  },
  {
    file: 'engine/src/render/uniform-ring.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: 'this.uniformRing?.destroy()' },
  },
  {
    file: 'engine/src/render/uniform-slot-arena.ts',
    method: 'destroy',
    via: { file: 'map/src/render/tile-uniform-arena.ts', pattern: '.destroy()' },
  },
  // ── map: orchestration ──
  { file: 'map/src/map.ts', method: 'destroy', tier: 'api-root' },
  {
    file: 'map/src/controller.ts',
    method: 'detach',
    via: { file: 'map/src/map.ts', pattern: 'controller?.detach()' },
  },
  {
    file: 'map/src/cursor.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: '_cursor?.destroy()' },
  },
  {
    file: 'map/src/event-dispatcher.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'eventDispatcher?.destroy()' },
  },
  {
    file: 'map/src/feature-update-queue.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'featureUpdateQueue.destroy()' },
  },
  {
    file: 'map/src/stats.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: '_statsPanel.destroy()' },
  },
  // ── map: graphics/sprite/text ──
  {
    file: 'map/src/graphics/compiled-arrow-store.ts',
    method: 'destroyGpu',
    via: { file: 'map/src/graphics/graphics-manager.ts', pattern: '_compiledArrows.destroyGpu()' },
  },
  {
    file: 'map/src/graphics/graphics-manager.ts',
    method: 'destroyGpu',
    via: { file: 'map/src/map.ts', pattern: 'graphics.destroyGpu()' },
  },
  {
    file: 'map/src/graphics/retained-draper-set.ts',
    method: 'detach',
    via: { file: 'map/src/graphics/graphics-manager.ts', pattern: '.detach()' },
  },
  {
    file: 'map/src/sprite/host-sprite-atlas-gpu.ts',
    method: 'destroy',
    via: { file: 'map/src/graphics/graphics-manager.ts', pattern: 'atlas?.destroy()' },
  },
  {
    file: 'map/src/sprite/host-sprite-atlas-rhi.ts',
    method: 'destroy',
    via: { file: 'map/src/graphics/graphics-manager.ts', pattern: 'atlas?.destroy()' },
  },
  {
    file: 'map/src/sprite/icon-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/sprite/icon-stage.ts', pattern: 'this.renderer.destroy()' },
  },
  {
    file: 'map/src/sprite/icon-stage.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'iconStage?.destroy()' },
  },
  {
    file: 'map/src/sprite/sprite-atlas-gpu.ts',
    method: 'destroy',
    via: { file: 'map/src/sprite/icon-stage.ts', pattern: 'this.gpu.destroy()' },
  },
  {
    file: 'map/src/text/sdf/glyph-atlas-gpu.ts',
    method: 'destroy',
    via: { file: 'map/src/text/text-stage.ts', pattern: '.destroy()' },
  },
  {
    file: 'map/src/text/sdf/glyph-atlas-host.ts',
    method: 'destroy',
    via: { file: 'map/src/text/text-stage.ts', pattern: 'host.destroy()' },
  },
  {
    file: 'map/src/text/text-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/text/text-stage.ts', pattern: 'renderer.destroy()' },
  },
  {
    file: 'map/src/text/text-stage.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'textStage?.destroy()' },
  },
  // ── map: render core ──
  {
    file: 'map/src/render/compute-layer-handle.ts',
    method: 'destroy',
    via: { file: 'map/src/render/feature-data-binder.ts', pattern: 'handle.destroy()' },
  },
  {
    file: 'map/src/render/compute-layer-registry.ts',
    method: 'destroyAll',
    via: { file: 'map/src/render/renderer.ts', pattern: 'registry?.destroyAll()' },
  },
  {
    file: 'map/src/render/coverage-renderer.ts',
    method: 'dispose',
    via: { file: 'map/src/map.ts', pattern: 'coverageRenderer?.dispose()' },
  },
  {
    file: 'map/src/render/feature-data-binder.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_featureBinder.destroy()' },
  },
  {
    file: 'map/src/render/flow-renderer.ts',
    method: 'dispose',
    via: { file: 'map/src/map.ts', pattern: 'flowRenderer?.dispose()' },
  },
  {
    file: 'map/src/render/flow-stepper.ts',
    method: 'destroy',
    via: { file: 'map/src/render/flow-renderer.ts', pattern: 'stepper.destroy()' },
  },
  {
    file: 'map/src/render/flow-targets.ts',
    method: 'destroy',
    via: { file: 'map/src/render/flow-stepper.ts', pattern: '.destroy()' },
  },
  // DORMANT (audit): never instantiated in prod; file header says so and the
  // incomplete-work inventory lists it "delete or adopt".
  { file: 'map/src/render/frame-uniform.ts', method: 'destroy', tier: 'dormant' },
  {
    file: 'map/src/render/gpu-buffer-pool.ts',
    method: 'destroy',
    via: { file: 'map/src/render/gpu-tile-store.ts', pattern: '_pool.destroy()' },
  },
  {
    file: 'map/src/render/gpu-tile-store.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_store.destroy()' },
  },
  {
    file: 'map/src/render/heatmap-targets.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'heatmapTargets.destroy()' },
  },
  {
    file: 'map/src/render/hillshade-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'hillshadeRenderer?.destroy()' },
  },
  {
    file: 'map/src/render/raster-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'rasterRenderer?.destroy()' },
  },
  {
    file: 'map/src/render/rhi-fill-variant.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_fillVariantsRhi?.destroy()' },
  },
  {
    file: 'map/src/render/tile-compute-resources.ts',
    method: 'destroy',
    via: { file: 'map/src/render/compute-layer-handle.ts', pattern: 'this.resources.destroy()' },
  },
  {
    file: 'map/src/render/tile-uniform-arena.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_tileUniforms.destroy()' },
  },
  {
    file: 'map/src/render/under-occluder-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'underOccluder.destroy()' },
  },
  {
    file: 'map/src/render/uniform-split-bind.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_splitBind?.destroy()' },
  },
  {
    file: 'map/src/render/upload-coordinator.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_uploads.destroy()' },
  },
  {
    file: 'map/src/render/vector-drape-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: '_drape?.destroy()' },
  },
  {
    file: 'map/src/render/vector-tile-renderer.ts',
    method: 'destroy',
    via: { file: 'map/src/map-teardown.ts', pattern: 'renderer.destroy()' },
  },
  // ── map: drapers (the #1578 quality-flip release edges) ──
  {
    file: 'map/src/render/material/coverage-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/coverage-renderer.ts', pattern: 'd.destroy()' },
  },
  {
    file: 'map/src/render/material/extrude-shell-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/passes/oit-pass.ts', pattern: 'draper.destroy()' },
  },
  {
    file: 'map/src/render/material/hillshade-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/hillshade-renderer.ts', pattern: '_hillshadeDraper?.destroy()' },
  },
  {
    file: 'map/src/render/material/line-composite-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/line-renderer.ts', pattern: '_compositeDraper?.destroy()' },
  },
  {
    file: 'map/src/render/material/line-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/line-renderer.ts', pattern: '_lineDrapers.forEach' },
  },
  {
    file: 'map/src/render/material/point-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/point-renderer.ts', pattern: '_pointDrapers.forEach' },
  },
  {
    file: 'map/src/render/material/raster-material.ts',
    method: 'destroy',
    via: { file: 'map/src/render/raster-renderer.ts', pattern: '_rasterDraper?.destroy()' },
  },
  // ── rhi backends ──
  {
    file: 'rhi-webgl2/src/rhi-webgl2.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'rhi.destroy()' },
  },
  {
    file: 'rhi-webgpu/src/rhi-webgpu.ts',
    method: 'destroy',
    via: { file: 'map/src/map.ts', pattern: 'rhi.destroy()' },
  },
  // DORMANT (audit): "Should be called on map destroy when ?gpuprof=1" per
  // its own doc — zero callers repo-wide; device destroy reclaims. Delete or
  // adopt in a later phase.
  { file: 'rhi-webgpu/src/gpu-timer.ts', method: 'dispose', tier: 'dormant' },
  {
    file: 'rhi-webgpu/src/staging-buffer-pool.ts',
    method: 'dispose',
    via: { file: 'map/src/render/vector-tile-renderer.ts', pattern: 'stagingPool.dispose()' },
  },
]

// ── scanner (pure over source text) ─────────────────────────────────────────

const DECL = new RegExp(`^ {2}(${METHODS.join('|')})\\(\\): void \\{`, 'gm')

/** Zero-arg teardown-method declarations in one file's source. */
export function scanDeclarations(source: string): LifecycleMethod[] {
  const out: LifecycleMethod[] = []
  for (const m of source.matchAll(DECL)) out.push(m[1] as LifecycleMethod)
  return out
}

interface AuditInput {
  /** repo-relative file → source text (prod .ts only). */
  sources: Map<string, string>
  table: Row[]
}

interface AuditResult {
  /** scanned declarations with no table row. */
  unregistered: string[]
  /** table rows whose declaration no longer exists. */
  staleRows: string[]
  /** via rows whose caller file is missing or pattern no longer matches. */
  deadAnchors: string[]
}

export function auditReachability({ sources, table }: AuditInput): AuditResult {
  const declared = new Set<string>()
  for (const [file, src] of sources) {
    for (const method of scanDeclarations(src)) declared.add(`${file}#${method}`)
  }
  const rowKeys = new Set(table.map((r) => `${r.file}#${r.method}`))
  const unregistered = [...declared].filter((k) => !rowKeys.has(k)).sort()
  const staleRows = table
    .filter((r) => !declared.has(`${r.file}#${r.method}`))
    .map((r) => `${r.file}#${r.method}`)
  const deadAnchors = table
    .filter((r) => r.via)
    .filter((r) => {
      const callerSrc = sources.get(r.via!.file)
      return callerSrc === undefined || !callerSrc.includes(r.via!.pattern)
    })
    .map((r) => `${r.file}#${r.method} via ${r.via!.file} :: "${r.via!.pattern}"`)
  return { unregistered, staleRows, deadAnchors }
}

function readProdSources(): Map<string, string> {
  const sources = new Map<string, string>()
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(REPO_ROOT, rel))) {
      const relPath = `${rel}/${name}`
      const abs = join(REPO_ROOT, relPath)
      if (statSync(abs).isDirectory()) {
        walk(relPath)
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
        sources.set(relPath, readFileSync(abs, 'utf8'))
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return sources
}

// ── the gate ────────────────────────────────────────────────────────────────

describe('teardown-reachability ratchet (#2266)', () => {
  const result = auditReachability({ sources: readProdSources(), table: TABLE })

  it('every teardown method is registered: a caller anchor or an explicit tier', () => {
    expect(
      result.unregistered,
      'new destroy()/dispose()/detach() with no lifecycle row — name its caller or class it (page/dormant/api-root)',
    ).toEqual([])
  })

  it('no stale rows — every registered declaration still exists (§12 key-resolution)', () => {
    expect(result.staleRows, 'row outlived its method — update or remove it').toEqual([])
  })

  it('no dead caller anchors — every audited reachability edge still holds', () => {
    expect(
      result.deadAnchors,
      'a teardown call was refactored away — re-anchor the row or the method just became unreachable',
    ).toEqual([])
  })

  it('NON-VACUITY — an unregistered declaration is flagged', () => {
    const sources = new Map([['x/src/a.ts', 'class A {\n  destroy(): void {\n  }\n}\n']])
    expect(auditReachability({ sources, table: [] }).unregistered).toEqual(['x/src/a.ts#destroy'])
  })

  it('NON-VACUITY — a stale row is flagged', () => {
    const sources = new Map([['x/src/a.ts', 'class A {}\n']])
    const table: Row[] = [{ file: 'x/src/a.ts', method: 'destroy', tier: 'dormant' }]
    expect(auditReachability({ sources, table }).staleRows).toEqual(['x/src/a.ts#destroy'])
  })

  it('NON-VACUITY — a dead caller anchor is flagged', () => {
    const sources = new Map([
      ['x/src/a.ts', 'class A {\n  destroy(): void {\n  }\n}\n'],
      ['x/src/b.ts', '// no call here\n'],
    ])
    const table: Row[] = [
      {
        file: 'x/src/a.ts',
        method: 'destroy',
        via: { file: 'x/src/b.ts', pattern: 'a.destroy()' },
      },
    ]
    expect(auditReachability({ sources, table }).deadAnchors).toEqual([
      'x/src/a.ts#destroy via x/src/b.ts :: "a.destroy()"',
    ])
  })

  it('CONTROL — interface members (no body brace) are outside the scanner', () => {
    expect(scanDeclarations('interface I {\n  destroy(): void\n  detach(): void\n}\n')).toEqual([])
  })
})
