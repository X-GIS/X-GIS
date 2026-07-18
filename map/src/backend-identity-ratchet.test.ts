// ═══ Backend-identity ratchet — `backend === / !== 'webgl2'|'webgpu'` shrink-only (#1046 F1) ═══
//
// The twin-frame program replaces backend-IDENTITY switches (`backend === 'webgl2'`)
// with capability queries (`rhi.caps.*`, doc §1.4/§2). This gate locks the count of
// identity comparisons in map/src as a shrink-only high-water mark: a new one fails
// the build; each phase that ports a site to a cap LOWERS the baseline. It does NOT
// forbid the sites (they retire across F3–F6, ending at the annotated #991 P6/P7
// residue, doc §6.3), it forbids GROWTH.
//
// Baseline 38 measured at fdcb3a1 (2026-07-14): 34 `===` sites + 4 `!==` sites — the
// doc's "38 non-test backend === sites" (§1.4) counts both comparison directions, since
// a `backend !==` is just as much an identity switch as a `backend ===`.
// 38→39 (#826): RetainedParticleDraper's GLSL-twin-source guard (particle-retained-
// material.ts) — the SAME #823 dual-source-material pattern every sibling draper in the
// baseline carries (arrow/circle/icon). A new dual-source primitive structurally needs
// this one identity read until the twin-source selection gets a real cap (no RhiCaps
// field expresses "consumes GLSL ES 3.00 sources" today); it retires with the others
// across F3–F6.
// 39→43 (#777 Phase II): HillshadeRenderer mirrors RasterRenderer's four backend
// splits — the DEM tile load (webgl2 bitmap+copyExternalImage vs webgpu
// loadImageTexture), the getSampleCount pick, the draw-pass wrap, and the evict
// destroy. Same still-blocked pattern raster-renderer carries; retires when the
// tile-load / pass-wrap / destroy sites move behind rhi.caps.* alongside raster.
//
// Applies the #996 lesson (a source-scan gate whose matcher silently matches nothing is
// vacuously green): two guards below prove the regex still matches AND the walk still
// reaches the real tree, so `count <= BASELINE` can never pass by scanning an empty set.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAP_SRC = join(dirname(fileURLToPath(import.meta.url)))
const BASELINE = 43

// `.backend` identity comparison, either direction, against either backend literal.
const PATTERN = 'backend\\s*(===|!==)\\s*[\'"](webgl2|webgpu)[\'"]'
const makeRe = (): RegExp => new RegExp(PATTERN, 'g')

function walkSrcTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkSrcTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}

function countIn(abs: string): number {
  return (readFileSync(abs, 'utf8').match(makeRe()) ?? []).length
}

describe('backend-identity ratchet: map/src `backend ===/!==` shrink-only (#1046 F1)', () => {
  const files = walkSrcTs(MAP_SRC)

  it('the matcher still matches identity comparisons (not vacuous — #996)', () => {
    expect("if (dev.backend === 'webgl2')".match(makeRe())).toHaveLength(1)
    expect("x.backend !== 'webgpu' && y.backend === 'webgl2'".match(makeRe())).toHaveLength(2)
    // must NOT match a non-identity comparison or an unrelated backend literal
    expect("backend === 'metal'".match(makeRe())).toBeNull()
    expect('caps.compute === "native"'.match(makeRe())).toBeNull()
  })

  it('the walk reaches the real map/src tree (not vacuous — #996)', () => {
    expect(files.length).toBeGreaterThan(0)
    // render-loop.ts is the stable frame shell — its presence proves the walk hit the tree.
    expect(files.some((f) => f.endsWith(join('map', 'src', 'render-loop.ts')))).toBe(true)
  })

  it(`no more than ${BASELINE} backend-identity comparisons in map/src (shrink-only)`, () => {
    const perFile = files
      .map((f) => ({ f, n: countIn(f) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
    const total = perFile.reduce((s, x) => s + x.n, 0)
    const breakdown = perFile
      .map((x) => `  ${x.n}  ${x.f.slice(x.f.indexOf('map/src'))}`)
      .join('\n')
    expect(
      total,
      `map/src holds ${total} backend-identity comparisons (> baseline ${BASELINE}). ` +
        `Replace with rhi.caps.* (doc §2) or lower the baseline when a phase ports sites.\n${breakdown}`,
    ).toBeLessThanOrEqual(BASELINE)
  })
})
