// #777 cluster I-F — icon-opacity value-form resolution (STALE-ROW probe + guard).
//
// §1.3 of the gap-matrix plan flags the runtime capability row
// `icon-opacity:zoom-interp` (capabilities/symbol.ts) as SUSPECTED STALE: the
// note claims "Per-feature alpha attr path deferred", but resolveLabelEffectiveDef
// (render-loop-helpers.ts) already resolves a zoom-interpolated icon-opacity
// PropertyShape per frame via resolveNumberShape → effectiveDef.iconOpacity.
//
// This test resolves the truth FIRST (the plan's ordered first task): drive the
// REAL resolveLabelEffectiveDef against a zoom-interpolated icon-opacity shape
// and assert the effectiveDef.iconOpacity tracks the zoom. It is GREEN on
// pristine source → the row is a stale doc/capability flip, NOT a code gap.
//
// The data-driven companion asserts the OTHER contract cluster I-F relies on:
// resolveLabelEffectiveDef must NOT resolve a data-driven icon-opacity here (it
// falls through to the static def.iconOpacity) so the per-feature applyFeatureExprs
// evaluator downstream owns the per-feature alpha. If this fall-through broke, the
// per-feature path would be silently clobbered by the shape resolver's `1`.

import { describe, expect, it } from 'vitest'
import { resolveLabelEffectiveDef } from './render-loop-helpers'
import type { LabelDef } from '@xgis/compiler'

type NumShape =
  | { kind: 'constant'; value: number }
  | { kind: 'zoom-interpolated'; stops: { zoom: number; value: number }[]; base?: number }
  | { kind: 'data-driven'; expr: { ast: unknown } }

/** Minimal LabelShapes bundle carrying a chosen icon-opacity shape; every other
 *  axis is a benign constant/null so resolveLabelEffectiveDef only exercises the
 *  icon-opacity path under test. */
function shapesWithIconOpacity(iconOpacity: NumShape | null): NonNullable<LabelDef['shapes']> {
  return {
    textPaint: { color: null, haloWidth: null, haloColor: null, haloBlur: null, opacity: null },
    textLayout: {
      size: { kind: 'constant', value: 12 },
      font: null,
      fontWeight: null,
      fontStyle: null,
    },
    icon: { iconSize: null, iconOpacity, iconColor: null },
  } as NonNullable<LabelDef['shapes']>
}

function defWith(iconOpacity: NumShape | null, staticFallback: number): LabelDef {
  const shapes = shapesWithIconOpacity(iconOpacity)
  return {
    text: { kind: 'template', parts: [] },
    size: 12,
    iconImage: 'marker',
    iconOpacity: staticFallback,
    shapes,
  } as unknown as LabelDef
}

/** iconOpacity after resolveLabelEffectiveDef at a given camera zoom. */
function resolvedIconOpacity(def: LabelDef, z: number): number | undefined {
  return resolveLabelEffectiveDef(def, def.shapes, z, 0, null, 0).iconOpacity
}

describe('icon-opacity zoom-interp resolution (STALE-ROW probe, #777 I-F §1.3)', () => {
  // stops: z10 → 1.0, z14 → 0.2 (linear, base 1). Midpoint z12 → 0.6.
  const zoomShape: NumShape = {
    kind: 'zoom-interpolated',
    stops: [
      { zoom: 10, value: 1 },
      { zoom: 14, value: 0.2 },
    ],
  }

  it('resolveLabelEffectiveDef interpolates icon-opacity by zoom (GREEN on pristine ⇒ row stale)', () => {
    const def = defWith(zoomShape, 1)
    expect(resolvedIconOpacity(def, 10)).toBeCloseTo(1.0, 6)
    expect(resolvedIconOpacity(def, 12)).toBeCloseTo(0.6, 6)
    expect(resolvedIconOpacity(def, 14)).toBeCloseTo(0.2, 6)
  })

  it('clamps to stop endpoints below/above the stop range', () => {
    const def = defWith(zoomShape, 1)
    expect(resolvedIconOpacity(def, 8)).toBeCloseTo(1.0, 6)
    expect(resolvedIconOpacity(def, 18)).toBeCloseTo(0.2, 6)
  })

  it('constant icon-opacity shape resolves to the constant (not the static fallback)', () => {
    const def = defWith({ kind: 'constant', value: 0.35 }, 1)
    expect(resolvedIconOpacity(def, 12)).toBeCloseTo(0.35, 6)
  })

  it('data-driven icon-opacity falls through to the static def.iconOpacity (per-feature path owns it)', () => {
    // The resolver must NOT collapse data-driven to resolveNumberShape's `1`
    // placeholder; it leaves the static fallback so applyFeatureExprs overrides
    // per feature downstream.
    const def = defWith({ kind: 'data-driven', expr: { ast: {} } }, 0.9)
    expect(resolvedIconOpacity(def, 12)).toBeCloseTo(0.9, 6)
  })
})
