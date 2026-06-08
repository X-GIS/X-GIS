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
  'runtime/src/engine/render/vector-tile-renderer.ts': 5440,
  'runtime/src/engine/map.ts': 3423,
  'compiler/src/ir/lower.ts': 2184,
  'runtime/src/engine/text/text-stage.ts': 2040,
  'compiler/src/tiler/vector-tiler.ts': 1997,
  'runtime/src/engine/render/renderer.ts': 1947,
  'compiler/src/convert/layers.ts': 1539,
  'compiler/src/convert/expressions.ts': 1534,
  'runtime/src/data/tile-catalog.ts': 1388,
  'blueprint/src/editor.ts': 1353,
  'runtime/src/engine/shader-dsl/shaders/line.ts': 1189,
  'compiler/src/parser/parser.ts': 1171,
  'runtime/src/engine/shader-dsl/shaders/polygon.ts': 1139,
  'runtime/src/engine/projection/camera.ts': 1087,
  'runtime/src/engine/render/passes/label-pass.ts': 1065,
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
  'runtime/src/engine/projection/camera.ts': 8,
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
