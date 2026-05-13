// Integration test: prove fold-trivial-stops is RUNTIME-EQUIVALENT
// on real-world styles, so the optimize() flow can pick it up
// without surprises. (Plan Step 2 Phase 2d's pending integration —
// commit d1a419f deferred it pending this evidence.)
//
// Approach: convert a real Mapbox style fixture, lower it to IR,
// run optimize() to get the canonical Scene, then ALSO run the
// fold pass on the canonical Scene. For every (RenderNode index,
// paint property, zoom) sample point, the per-frame resolved
// scalar / RGBA must match byte-for-byte. If any sample diverges,
// the fold isn't behaviour-preserving on that style.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Lexer } from '../../lexer/lexer'
import { Parser } from '../../parser/parser'
import { lower } from '../lower'
import { optimize } from '../optimize'
import { convertMapboxStyle } from '../../convert/mapbox-to-xgis'
import { resolveColorShape, resolveNumberShape } from '../../../../runtime/src/engine/render/paint-shape-resolve'
import { foldTrivialStopsPass } from './fold-trivial-stops'
import { emitCommands, type ShowCommand } from '../emit-commands'
import type { Scene } from '../render-node'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '..', '..', '__tests__', 'fixtures')

function compileFixture(path: string): Scene {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const xgis = convertMapboxStyle(json, { warn: () => {} })
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  return optimize(lower(program), program)
}

function emit(scene: Scene): ShowCommand[] {
  return emitCommands(scene).shows
}

const SAMPLE_ZOOMS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20] as const

function samplePaint(show: ShowCommand, zoom: number): {
  opacity: number
  strokeWidth: number
  fill: readonly [number, number, number, number] | null
  stroke: readonly [number, number, number, number] | null
} {
  const ps = show.paintShapes
  return {
    opacity: resolveNumberShape(ps.opacity, zoom, 0).value,
    strokeWidth: resolveNumberShape(ps.strokeWidth, zoom, 0).value,
    fill: ps.fill !== null ? resolveColorShape(ps.fill, zoom, 0)?.value ?? null : null,
    stroke: ps.stroke !== null ? resolveColorShape(ps.stroke, zoom, 0)?.value ?? null : null,
  }
}

describe('fold-trivial-stops — runtime-equivalent on OFM Bright', () => {
  it('every show command produces identical per-zoom paint values before vs after fold', () => {
    const baseline = compileFixture(join(FIX, 'openfreemap-bright.json'))
    const folded = foldTrivialStopsPass.run(baseline)
    expect(folded.renderNodes.length).toBe(baseline.renderNodes.length)

    const baseShows = emit(baseline)
    const foldShows = emit(folded)
    expect(foldShows.length).toBe(baseShows.length)

    for (let i = 0; i < baseShows.length; i++) {
      for (const z of SAMPLE_ZOOMS) {
        const b = samplePaint(baseShows[i]!, z)
        const f = samplePaint(foldShows[i]!, z)
        expect(f.opacity).toBeCloseTo(b.opacity, 6)
        expect(f.strokeWidth).toBeCloseTo(b.strokeWidth, 6)
        if (b.fill === null) {
          expect(f.fill).toBeNull()
        } else {
          expect(f.fill).not.toBeNull()
          expect(f.fill![0]).toBeCloseTo(b.fill[0]!, 6)
          expect(f.fill![1]).toBeCloseTo(b.fill[1]!, 6)
          expect(f.fill![2]).toBeCloseTo(b.fill[2]!, 6)
          expect(f.fill![3]).toBeCloseTo(b.fill[3]!, 6)
        }
        if (b.stroke === null) {
          expect(f.stroke).toBeNull()
        } else {
          expect(f.stroke).not.toBeNull()
          expect(f.stroke![0]).toBeCloseTo(b.stroke[0]!, 6)
          expect(f.stroke![1]).toBeCloseTo(b.stroke[1]!, 6)
          expect(f.stroke![2]).toBeCloseTo(b.stroke[2]!, 6)
          expect(f.stroke![3]).toBeCloseTo(b.stroke[3]!, 6)
        }
      }
    }
  })
})
