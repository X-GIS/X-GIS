// ═══ projType-confinement ratchet — branch on the membership table, not projType ═══
//
// Charter (docs/architecture/package-responsibilities.md): projection-type dispatch
// belongs in the projections table (geo/src/projections-table.ts) behind membership
// accessors (isCylindrical / isFlat / isOrtho / …); scattered `projType ===/!==`
// branches are the anti-pattern. The old Gate-4 (runtime arch-invariants) enforced
// this, but it went VACUOUS (#996): its allowlist keys on deleted runtime files
// (`runtime/src/engine/projection/{camera,unproject}.ts`, `controller.ts`), it walks
// only runtime/compiler/blueprint/shared, and it has no stale-check — so the ~25 LIVE
// branches, which moved to map/geo/data in P3, are entirely un-gated.
//
// This is the revival, co-located under map/src (rides `test (map)`, reads map/geo/
// data — not the retiring runtime/ tree, #1005). STRICT shrink-only (both directions
// + union scan) like the raw-webgpu ratchet, so a moved/deleted baselined file fails
// loudly instead of silently — the exact trap #996 documents. Drive each count to 0
// by routing the branch through a projections-table membership accessor.
//
// The authority file geo/src/projections-table.ts is EXCLUDED — it is where
// projType dispatch legitimately lives.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// compiler/blueprint/shared carried from the retiring runtime Gate 4 (#1005):
// they are projType-clean today (zero baseline entries) and must stay so.
const PKGS = ['map/src', 'geo/src', 'data/src', 'compiler/src', 'blueprint/src', 'shared/src']
const AUTHORITY = 'geo/src/projections-table.ts' // projType dispatch lives here

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

const PROJTYPE_RE = /projType\s*[!=]==/g
function projTypeCount(abs: string): number {
  return (stripComments(readFileSync(abs, 'utf8')).match(PROJTYPE_RE) || []).length
}

// Per-file `projType ===/!==` count. SHRINK-ONLY: route a branch through a
// projections-table membership accessor to lower it (0 = delete the entry).
// Measured 2026-07-11. Ordered by path.
const BASELINE: Record<string, number> = {
  'data/src/tile-select.ts': 1,
  'data/src/tiles-sse.ts': 3,
  'map/src/camera/camera.ts': 6,
  'map/src/camera/unproject.ts': 4,
  'map/src/controller.ts': 6,
  // #1006: point-renderer + heatmap-renderer each held an identical `projType === 0`
  // camera-anchor split inline; both were deduped into cameraAnchorDsfun() (single
  // authority), so the two entries collapse to ONE here (net 2 → 1 comparisons).
  // The `=== 0` is Mercator-SPECIFIC (only projType 0 uses the 2D centre; flat 1/2
  // use ECEF), and isFlat/isCylindrical are broader (true for 0/1/2), so there is no
  // membership accessor that preserves this exactly — genuinely still-blocked.
  'map/src/render/camera-anchor-dsfun.ts': 1,
  'map/src/render/prefetch-scheduler.ts': 1,
  'map/src/render/raster-renderer.ts': 2,
}

describe('projType-confinement ratchet: dispatch via the membership table (#996)', () => {
  it('per-file projType-comparison count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const pk of PKGS) {
      for (const abs of walkTs(join(ROOT, pk))) {
        const r = rel(abs)
        if (r === AUTHORITY) continue
        const n = projTypeCount(abs)
        if (n > 0) actual.set(r, n)
      }
    }

    const files = [...new Set([...actual.keys(), ...Object.keys(BASELINE)])].sort()
    const violations: string[] = []
    for (const f of files) {
      const a = actual.get(f) ?? 0
      const b = BASELINE[f] ?? 0
      if (a === b) continue
      if (b === 0)
        violations.push(
          `${f}: ${a} projType comparison(s), not in baseline — route through a ` +
            `projections-table membership accessor (isCylindrical/isFlat/isOrtho/…)`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (routed; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW projType branch; route through the membership table`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — branch(es) routed; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `projType-branching drifted from the #996 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
