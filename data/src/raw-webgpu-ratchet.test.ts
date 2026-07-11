// ═══ Raw-WebGPU ratchet — @xgis/data must stay GPU-free ═══
//
// Charter (docs/architecture/package-responsibilities.md — the `data` row): the
// data/source layer feeds the render layer but "must NOT" hold GPU types / do GPU
// upload (→ render/VTR). Yet `data/src` currently holds native WebGPU, and nothing
// gates it: the #929 dependency-direction ratchet doesn't see ambient
// `@webgpu/types`, and the #991 raw-webgpu ratchet is scoped to `map/src`. This is
// the missing gate (companion to map/src/raw-webgpu-ratchet.test.ts, same signal +
// STRICT shrink-only convention — see that file's header for the full rationale).
//
// The current 6 tokens (data/src/tile-select.ts + tile-select-types.ts) are the
// GPU texture-upload seam flagged in #997; they are BASELINED here to lock the
// footprint (no NEW GPU touch in data), and driven to 0 when that path relocates to
// the render layer (@xgis/map) — the reduction lowers the baseline in the same
// commit. Close-out = this map == {} (data fully GPU-free).
//
// GPU-free; rides the `test (engine-rhi-data)` CI leg (which runs `data/src`).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA_SRC = join(ROOT, 'data/src')

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// X-GIS-own GPU-prefixed identifiers — NOT native WebGPU; never counted.
const XGIS_OWN = new Set([
  'GPUArena',
  'GPUArenas',
  'GPUArenaOptions',
  'GPUTimer',
  'GPUContext',
  'GPUTile',
  'GPUTiles',
])
const NATIVE_RE = /\bGPU[A-Z][A-Za-z0-9]*\b/g
const UNWRAP_RE = /\bunwrapBuffer\b/g

function rawWebgpuCount(abs: string): number {
  const code = stripComments(readFileSync(abs, 'utf8'))
  let n = 0
  for (const m of code.matchAll(NATIVE_RE)) if (!XGIS_OWN.has(m[0])) n++
  n += (code.match(UNWRAP_RE) || []).length
  return n
}

// Per-file raw-WebGPU token count. SHRINK-ONLY: relocating the GPU texture-upload
// path out of @xgis/data (to the render layer) lowers these to 0 in the same commit.
// Measured 2026-07-11. Ordered by path.
const BASELINE: Record<string, number> = {
  'data/src/tile-select-types.ts': 1,
  'data/src/tile-select.ts': 5,
}

describe('raw-WebGPU ratchet: @xgis/data is GPU-free (#997)', () => {
  it('per-file raw-WebGPU token count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const abs of walkTs(DATA_SRC)) {
      const n = rawWebgpuCount(abs)
      if (n > 0) actual.set(rel(abs), n)
    }

    const files = [...new Set([...actual.keys(), ...Object.keys(BASELINE)])].sort()
    const violations: string[] = []
    for (const f of files) {
      const a = actual.get(f) ?? 0
      const b = BASELINE[f] ?? 0
      if (a === b) continue
      if (b === 0)
        violations.push(
          `${f}: ${a} raw-WebGPU token(s), not in baseline — @xgis/data must be GPU-free; ` +
            `move GPU work to the render layer (@xgis/map)`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (GPU-free; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW GPU coupling in @xgis/data; move it to the render layer`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — GPU coupling removed; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `@xgis/data GPU footprint drifted from the #997 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
