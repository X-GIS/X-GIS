// ═══ The constant-number binding table, and the misroute it makes visible ═══
//
// `bindingFallthroughHandler` used to carry sixteen
// `if (ctx.name === X) { acc.Y = n; return true }` arms differing only in X and Y
// (#2534). They are now one table, `CONST_NUMBER_BINDINGS`.
//
// A table has a failure mode the ladder did not: ONE typo'd row silently misroutes a
// paint property — `'heatmap-weight': 'heatmapIntensity'` compiles, and every existing
// suite that checks its OWN property still passes, because the value does land somewhere.
// So the test that matters is not "does heatmap-weight work" (a per-property suite already
// asks that); it is the DIFFERENTIAL: the retired ladder is reproduced verbatim below, and
// every name is driven through both. A wrong row shows up as a disagreement naming both
// fields, and a MISSING row shows up as the ladder writing where the table wrote nothing.

import { describe, it, expect } from 'vitest'
import { bindingFallthroughHandler } from '../ir/lower-bindings-paint'
import type { BindingCtx, LayerAccumulator } from '../ir/lower-bindings'

// ── the retired ladder, verbatim ────────────────────────────────────────────────────────
// As it stood at 7edf9677. Kept as an independent second implementation — do NOT refactor
// it to read the table, which would make the differential vacuous.
function retiredLadder(acc: LayerAccumulator, name: string, n: number): boolean {
  if (name === 'fill-translate-x') return ((acc.fillTranslateX = n), true)
  if (name === 'fill-translate-y') return ((acc.fillTranslateY = n), true)
  if (name === 'circle-translate-x') return ((acc.circleTranslateX = n), true)
  if (name === 'circle-translate-y') return ((acc.circleTranslateY = n), true)
  if (name === 'circle-blur') return ((acc.circleBlur = n), true)
  if (name === 'stroke-translate-x') return ((acc.strokeTranslateX = n), true)
  if (name === 'stroke-translate-y') return ((acc.strokeTranslateY = n), true)
  if (name === 'raster-hue-rotate') return ((acc.rasterHueRotate = n), true)
  if (name === 'raster-brightness-min') return ((acc.rasterBrightnessMin = n), true)
  if (name === 'raster-brightness-max') return ((acc.rasterBrightnessMax = n), true)
  if (name === 'raster-saturation') return ((acc.rasterSaturation = n), true)
  if (name === 'raster-contrast') return ((acc.rasterContrast = n), true)
  if (name === 'heatmap-radius') return ((acc.heatmapRadius = n), true)
  if (name === 'heatmap-weight') return ((acc.heatmapWeight = n), true)
  if (name === 'heatmap-intensity') return ((acc.heatmapIntensity = n), true)
  if (name === 'heatmap-opacity') return ((acc.heatmapOpacity = n), true)
  return false
}

const LADDER_NAMES = [
  'fill-translate-x',
  'fill-translate-y',
  'circle-translate-x',
  'circle-translate-y',
  'circle-blur',
  'stroke-translate-x',
  'stroke-translate-y',
  'raster-hue-rotate',
  'raster-brightness-min',
  'raster-brightness-max',
  'raster-saturation',
  'raster-contrast',
  'heatmap-radius',
  'heatmap-weight',
  'heatmap-intensity',
  'heatmap-opacity',
] as const

/** A bare accumulator — only the fields this handler may touch need to exist, and every one
 *  starts `undefined` so "which field moved" is unambiguous. */
function emptyAcc(): LayerAccumulator {
  return {} as unknown as LayerAccumulator
}

/** Drive the real handler with a `<name>-[<n>]` constant-number binding. */
function runHandler(name: string, n: number): LayerAccumulator {
  const acc = emptyAcc()
  const ctx = {
    name,
    mod: null,
    item: { binding: { kind: 'NumberLiteral', value: n } },
    stmt: { line: 1 },
    diagnostics: [],
    options: {},
    acc,
  } as unknown as BindingCtx
  bindingFallthroughHandler.apply(ctx)
  return acc
}

/** Which fields a run actually wrote, as `field=value` pairs. */
const written = (acc: LayerAccumulator): string[] =>
  Object.entries(acc as unknown as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()

describe('CONST_NUMBER_BINDINGS — the table that replaced the 16-arm ladder (#2534)', () => {
  it('routes every ladder name to exactly the field the ladder routed it to', () => {
    // The misroute check. A typo'd row disagrees here naming BOTH fields, which no
    // per-property suite can see.
    for (const name of LADDER_NAMES) {
      const n = 1 + LADDER_NAMES.indexOf(name) // a distinct value per name
      const viaLadder = emptyAcc()
      expect(
        retiredLadder(viaLadder, name, n),
        `${name}: the retired ladder did not claim it`,
      ).toBe(true)
      expect(written(runHandler(name, n)), `${name} routed differently than the ladder`).toEqual(
        written(viaLadder),
      )
    }
  })

  it('writes EXACTLY one field per name — never a second one as a side effect', () => {
    for (const name of LADDER_NAMES) {
      expect(written(runHandler(name, 7)), `${name}`).toHaveLength(1)
    }
  })

  it('the 16 names map to 16 DISTINCT fields — no two rows share a target', () => {
    // Two rows pointing at one field is the other typo shape: `heatmap-weight` and
    // `heatmap-intensity` both writing `heatmapIntensity` would leave one property dead,
    // and the per-name differential above would catch it — but only because this holds.
    const targets = LADDER_NAMES.map((name) => written(runHandler(name, 1))[0]!.split('=')[0]!)
    expect(new Set(targets).size).toBe(LADDER_NAMES.length)
  })

  it('the differential is not vacuous — the ladder really does claim all 16 and reject others', () => {
    // If `retiredLadder` returned false everywhere, every comparison above would compare
    // two empty accumulators and pass.
    expect(LADDER_NAMES.filter((n) => retiredLadder(emptyAcc(), n, 1))).toHaveLength(16)
    for (const decoy of ['stroke', 'fill', 'opacity', 'hillshade-exaggeration', 'dash-offset']) {
      expect(retiredLadder(emptyAcc(), decoy, 1), `${decoy} must NOT be in this table`).toBe(false)
    }
  })

  it('a name outside the table writes nothing and raises the X-GIS0005 drop warning', () => {
    // The hole the diagnostic exists to close (the `stroke-[interpolate_exp(zoom, …)]`
    // silent drop). A table lookup that missed must fall through to it, not swallow.
    const acc = emptyAcc()
    const diagnostics: { severity: string; code: string; message: string }[] = []
    const ctx = {
      name: 'not-a-paint-prop',
      mod: null,
      item: { binding: { kind: 'NumberLiteral', value: 3 } },
      stmt: { line: 1 },
      diagnostics,
      options: {},
      acc,
    } as unknown as BindingCtx
    bindingFallthroughHandler.apply(ctx)
    expect(written(acc)).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.code).toBe('X-GIS0005')
    // The message must name the table, or an author follows it to a ladder that is gone.
    expect(diagnostics[0]!.message).toContain('CONST_NUMBER_BINDINGS')
    expect(diagnostics[0]!.message).toContain('not-a-paint-prop')
  })
})
