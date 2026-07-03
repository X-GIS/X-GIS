// AC2c.3.6 — background-pass coverage clear-value contract
//
// The whole-viewport colour clear was relocated from the opaque pass's
// first sub-pass into a dedicated background pass (bucket 0) — the
// coverage seam from docs/redesign/VISION.md §4, §5 gap #1 — and made
// projection-aware. This is a BEHAVIOURAL test of the pure
// `backgroundClearValue(projType, bg, overdraw)` helper (not a source-text
// regex): the vision calls for deterministic invariants over brittle text
// inspection. (Was opaque-pass-clear-value.test.ts.)
//
// Contract:
//   • Flat / cylindrical (mercator 0 / equirect 1 / natural_earth 2 /
//     oblique_mercator 6) → the style background-color fills the viewport.
//   • Disc / globe (orthographic 3 / azimuthal 4 / stereographic 5 /
//     globe 7) → defined pure-black space { r:0, g:0, b:0, a:1 }.
//   • Flat with no background block (bg = null) → defined black.
//   • ?debug=overdraw → { r:0, g:0, b:0, a:0 } (accumulator starts at 0).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { backgroundClearValue } from './background-pass'

const BLACK = { r: 0, g: 0, b: 0, a: 1 }
const ZERO = { r: 0, g: 0, b: 0, a: 0 }
const BG = [0.93, 0.91, 0.86, 1] as const // an OFM-Bright-ish parchment

describe('AC2c.3.6 — backgroundClearValue coverage contract', () => {
  // ── Flat / cylindrical → style background-color fills the viewport ──

  it.each([
    ['mercator', 0],
    ['equirectangular', 1],
    ['natural_earth', 2],
    ['oblique_mercator', 6],
  ])(
    'flat/cylindrical %s (projType %i) clears to the style background-color',
    (_name, projType) => {
      expect(backgroundClearValue(projType, BG, false)).toEqual({
        r: BG[0],
        g: BG[1],
        b: BG[2],
        a: BG[3],
      })
    },
  )

  // ── Disc / globe → defined pure-black space (iter-196 sentinel) ──

  it.each([
    ['orthographic', 3],
    ['azimuthal_equidistant', 4],
    ['stereographic', 5],
    ['globe', 7],
  ])(
    'disc/globe %s (projType %i) clears to pure-black space even when a background-color is set',
    (_name, projType) => {
      expect(backgroundClearValue(projType, BG, false)).toEqual(BLACK)
    },
  )

  // ── Flat with no background block → defined black (not an accident) ──

  it('flat projection with no background block (bg=null) falls back to defined black', () => {
    expect(backgroundClearValue(0, null, false)).toEqual(BLACK)
  })

  // ── Overdraw accumulator must start at zero, regardless of projType/bg ──

  it.each([0, 2, 3, 7])(
    'debug=overdraw clears the r16float accumulator to a:0 (projType %i)',
    (projType) => {
      expect(backgroundClearValue(projType, BG, true)).toEqual(ZERO)
    },
  )

  it('the pure-black space sentinel is exactly { r:0, g:0, b:0, a:1 } (not the prior dark-navy)', () => {
    expect(backgroundClearValue(7, null, false)).toEqual({ r: 0, g: 0, b: 0, a: 1 })
  })
})

// ── Guard: the clear actually MOVED out of opaque-pass (source-text) ──

const OPAQUE_PASS_SRC = readFileSync(resolve(__dirname, 'opaque-pass.ts'), 'utf8')

describe('AC2c.3.6 — opaque-pass no longer owns the colour clear', () => {
  it('opaque colour attachment LOADs (the a:1 colour clear moved to background-pass)', () => {
    expect(OPAQUE_PASS_SRC).not.toContain('{ r: 0, g: 0, b: 0, a: 1 }')
    expect(OPAQUE_PASS_SRC).toContain("loadOp: 'load'")
  })

  it('opaque-pass still clears depth/stencil and the pick attachment on its first sub-pass', () => {
    expect(OPAQUE_PASS_SRC).toContain("depthLoadOp: isFirst ? 'clear' : 'load'")
    expect(OPAQUE_PASS_SRC).toContain('{ r: 0, g: 0, b: 0, a: 0 }') // pick clear on isFirst
  })
})
