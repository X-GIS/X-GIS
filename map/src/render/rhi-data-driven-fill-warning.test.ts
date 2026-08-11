// ═══ The WebGL2 data-driven-fill gap announces itself, once per layer (#1583) ═══
//
// A fill whose colour lives in a shader variant draws NOTHING when this backend cannot compile
// that variant. Painting one flat colour over a choropleth would misreport the data, so the blank
// is the honest render; what #1583 changes is that it stops being SILENT.
//
// #1592 SHRANK the set this applies to, and did not empty it: the RHI path now compiles a variant
// Material and binds per-tile feat_data, so a plain `fill match(…)` paints its per-feature colours
// here. What still bails — and still must announce itself — is the residue `rhiVariantFillSupported`
// fences off: a variant that samples the palette atlas (`gradient()` / `categorical()`) or routes
// paint through a compute kernel. The message and its once-per-layer latch are unchanged, which is
// why every assertion below is: this file pins the REPORT, not the size of the gap it reports on.
//
// These drive the REAL `reportRhiFillGap`, not a local restatement of it. That distinction is the
// whole reason the function was extracted: its sibling `polygon-skip-fill-draw.test.ts` mirrors the
// WebGPU predicate, never calls the renderer, and stayed green for this bug's entire life while the
// RHI path violated the very assertion it makes. A second mirror would have inherited exactly that.
//
// Which variants reach the bail at all is `rhi-fill-variant.test.ts` (the #1592 fence); that a
// SUPPORTED one now paints its per-feature colours on a real WebGL2 context, silently, is
// `_fill-data-driven-gl2-gate.spec.ts`.

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
    paletteScalarGradients: [],
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
