// ═══ The WebGL2 data-driven-fill gap announces itself, once per layer (#1583) ═══
//
// `fill match(…)` / `fill gradient(…)` draw NOTHING on the WebGL2/RHI backend: the colour lives in
// a shader variant, and this backend compiles none (#1592). That is not fixable at the draw site —
// there is no colour to draw with — so the layer stays blank, which is the honest render: painting
// one flat colour over a choropleth would misreport the data. What #1583 changes is that the blank
// stops being SILENT.
//
// These drive the REAL `reportRhiFillGap`, not a local restatement of it. That distinction is the
// whole reason the function was extracted: its sibling `polygon-skip-fill-draw.test.ts` mirrors the
// WebGPU predicate, never calls the renderer, and stayed green for this bug's entire life while the
// RHI path violated the very assertion it makes. A second mirror would have inherited exactly that.
//
// The remaining claim — that it actually fires on a real data-driven layer, at the real bail, on a
// real WebGL2 context — is owned by `_fill-data-driven-gl2-gate.spec.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ShaderVariant } from '@xgis/compiler'
import { varRefVec4 } from '@xgis/compiler'
import type { ShowCommand } from './renderer-types'
import { reportRhiFillGap, resetRhiFillGapReports } from './rhi-fill-gap-warning'

function variant(opts: Partial<ShaderVariant>): ShaderVariant {
  return {
    key: 'k',
    preamble: {},
    fillExpr: varRefVec4('u.fill_color'),
    strokeExpr: varRefVec4('u.stroke_color'),
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: [],
    categoryOrder: {},
    paletteColorGradients: [],
    paletteScalarGradients: [],
    fillUsesPalette: false,
    strokeUsesPalette: false,
    opacityUsesPalette: false,
    fillIsDefault: true,
    strokeIsDefault: true,
    fillIsStage: false,
    strokeIsStage: false,
    ...opts,
  }
}

/** Only the three fields the report reads — a full ShowCommand would be scaffolding, not signal. */
const show = (layerName: string, v: ShaderVariant | null): ShowCommand =>
  ({ layerName, targetName: 'src', shaderVariant: v }) as unknown as ShowCommand

/** A data-driven fill: the compiler sets `fillIsDefault: false` exactly for `match`/`gradient`. */
const dataDriven = (layer: string): ShowCommand =>
  show(layer, variant({ fillIsDefault: false, fillExpr: varRefVec4('_mcL1') }))

beforeEach(() => resetRhiFillGapReports())

describe('reportRhiFillGap — what it reports (#1583)', () => {
  it('names the layer, the backend, and where the capability is tracked', () => {
    // An actionable message or none at all. "Something did not draw" would send the reader looking
    // for a bug in their style, which is the one place the problem is NOT.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(reportRhiFillGap(dataDriven('cats'), 'webgl2')).toBe(0)
      const msg = String(warn.mock.calls[0]?.[0] ?? '')
      expect(msg, 'the layer').toContain('"cats"')
      expect(msg, 'the backend').toContain('webgl2')
      expect(msg, 'the tracking issue').toContain('#1592')
      expect(msg, 'and that the style is not the thing at fault').toContain('not broken')
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to the source name when the layer is anonymous', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      reportRhiFillGap(show(undefined as unknown as string, variant({ fillIsDefault: false })), 'x')
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('"src"')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('reportRhiFillGap — when it stays quiet (#1583)', () => {
  // A null fill has two meanings and the guard separates them. The noisy direction is the failure
  // that matters: a warning every line-only layer triggers is a warning nobody reads, and this
  // fires from the per-frame path where "nobody reads it" arrives fast.

  it('a line-only layer says nothing — its null fill is the correct answer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(reportRhiFillGap(show('roads', null), 'webgl2')).toBe(0)
      expect(warn, 'no variant ⇒ no per-feature fill was ever promised').not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a constant-fill layer says nothing — its colour resolves on the CPU and paints', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      reportRhiFillGap(show('land', variant({ fillIsDefault: true })), 'webgl2')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('reportRhiFillGap — the latch (#1583)', () => {
  it('says it ONCE, however many times the frame loop asks', () => {
    // The call site runs per show per frame. At 60 fps an unlatched warn emits thousands of times
    // a minute and scrolls itself out of the console — indistinguishable, for the author it is
    // written for, from never having warned.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = dataDriven('cats')
      for (let frame = 0; frame < 120; frame++) reportRhiFillGap(s, 'webgl2')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('but once PER LAYER — three broken layers are three facts, not one', () => {
    // A global latch would report the first and hide the rest, understating a style's problem.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const l of ['cats', 'income', 'gdp', 'cats', 'income']) {
        reportRhiFillGap(dataDriven(l), 'webgl2')
      }
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })
})
