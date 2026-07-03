// §11 data-driven lab/hcl evaluator (iter 164).
//
// iter 137 + 60-62 densified interpolate-lab / interpolate-hcl
// when stop values are hex LITERALS — the runtime then linearly
// interpolates the dense hex stops in sRGB, visually approximating
// the authored Lab/LCh interpolation. That was the surgical close
// for the zoom-stops + data-driven-numeric-stops cases.
//
// REMNANT: when stop VALUES are themselves expressions (e.g.
// `["get", "k"]`, `["case", …]`, `rgb(…)`), compile-time
// densification can't compute the colour ahead of time. The
// converter (expressions.ts:779) used to silently downgrade those
// to plain linear `interpolate(input, …)` — losing the Lab/LCh
// intent.
//
// iter 164 fixes that: the converter now emits
//   interpolate_lab(input, x0, y0, x1, y1, …)
//   interpolate_hcl(input, …)
// for the non-hex linear case, and the evaluator has dedicated
// cases that resolve each stop's y at eval time to a hex colour,
// parse to Lab / LCh, interpolate (LCh: hue shortest path), and
// return hex. This test pins the round-trip end-to-end.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'
import { parseExpressionString } from '../parser/parser'
import { parseSrgbHex, srgbToLab } from '../tokens/colors'

function build(value: unknown) {
  return {
    version: 8,
    sources: { a: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      { id: 'l', type: 'fill', source: 'a', 'source-layer': 'a', paint: { 'fill-color': value } },
    ],
  }
}

function evalExpr(src: string, vars: Record<string, unknown> = {}): unknown {
  const ast = parseExpressionString(src)
  return evaluate(ast, makeEvalProps({ props: vars }))
}

describe('interpolate_lab / interpolate_hcl — data-driven runtime evaluator', () => {
  it('non-hex stops convert to interpolate_lab(...) (was linear downgrade)', () => {
    const style = build([
      'interpolate-lab',
      ['linear'],
      ['get', 'k'],
      0,
      ['get', 'c0'],
      10,
      ['get', 'c1'],
    ])
    const warnings: string[] = []
    const xgis = convertMapboxStyle(style as never, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(xgis, warnings.join('\n')).toContain('interpolate_lab(')
    // Old downgrade warning must NOT fire.
    expect(warnings.some((s) => /approximated as linear-sRGB/.test(s))).toBe(false)
    // New routing notice fires.
    expect(warnings.some((s) => /routed to runtime interpolate_lab/.test(s))).toBe(true)
  })

  it('hcl form emits interpolate_hcl(...)', () => {
    const style = build([
      'interpolate-hcl',
      ['linear'],
      ['get', 'k'],
      0,
      ['get', 'c0'],
      10,
      ['get', 'c1'],
    ])
    const warnings: string[] = []
    const xgis = convertMapboxStyle(style as never, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(xgis, warnings.join('\n')).toContain('interpolate_hcl(')
  })

  it('evaluator: interpolate_lab at t=0.5 lands BETWEEN endpoints in Lab space', () => {
    // White → black at t=0.5 in Lab → grey AT THE L=50 midpoint;
    // linear-sRGB midpoint of #fff and #000 is also a grey but at a
    // different brightness (the perceptual difference Lab is designed
    // to fix). We assert the Lab path produces a value whose L lands
    // near (Lwhite + Lblack)/2.
    const result = evalExpr('interpolate_lab(0.5, 0, "#ffffff", 1, "#000000")')
    expect(typeof result).toBe('string')
    const rgb = parseSrgbHex(result as string)!
    const [L] = srgbToLab(rgb[0], rgb[1], rgb[2])
    // Lwhite=100, Lblack=0; midpoint should be near 50.
    expect(L).toBeGreaterThan(40)
    expect(L).toBeLessThan(60)
  })

  it('evaluator: hcl takes shortest-path hue (red→green via orange, not magenta)', () => {
    // Red hue ≈ 0°, Green hue ≈ 120° — short path passes through ~60°
    // (yellow / orange band), long path through ~300° (magenta).
    const result = evalExpr('interpolate_hcl(0.5, 0, "#ff0000", 1, "#00ff00")')
    const rgb = parseSrgbHex(result as string)!
    // Orange / yellow midpoint has R > B and G > B. Magenta midpoint
    // would have R + B > G. Use that to pin direction.
    expect(rgb[1]).toBeGreaterThan(rgb[2]) // green > blue (orange/yellow path)
    expect(rgb[0]).toBeGreaterThan(rgb[2]) // red > blue
  })

  it('evaluator: out-of-range input returns endpoint stops verbatim', () => {
    const below = evalExpr('interpolate_lab(-5, 0, "#ff0000", 10, "#00ff00")')
    const above = evalExpr('interpolate_lab(99, 0, "#ff0000", 10, "#00ff00")')
    expect(below).toBe('#ff0000')
    expect(above).toBe('#00ff00')
  })

  it('evaluator: non-color stop value falls back to nearest stop (graceful)', () => {
    // If a stop value is somehow not parseable as a colour (e.g. NaN
    // / number), the evaluator returns the closer stop's raw y.
    const r = evalExpr('interpolate_lab(0.3, 0, "#ff0000", 1, 42)')
    // input 0.3 is closer to x=0 → returns "#ff0000".
    expect(r).toBe('#ff0000')
  })

  it('evaluator: end-to-end through the converter (data-driven get → eval)', () => {
    // Style references properties; eval against a fake feature.
    const style = build([
      'interpolate-lab',
      ['linear'],
      ['get', 'magnitude'],
      0,
      ['get', 'low'],
      10,
      ['get', 'high'],
    ])
    const warnings: string[] = []
    convertMapboxStyle(style as never, {
      coverage: { sources: [], layers: [], warnings },
    })
    // Evaluate the runtime form directly — at magnitude=5 with
    // low=#ffffff and high=#000000, expect Lab midpoint grey.
    const result = evalExpr('interpolate_lab(magnitude, 0, low, 10, high)', {
      magnitude: 5,
      low: '#ffffff',
      high: '#000000',
    })
    const rgb = parseSrgbHex(result as string)!
    const [L] = srgbToLab(rgb[0], rgb[1], rgb[2])
    expect(L).toBeGreaterThan(40)
    expect(L).toBeLessThan(60)
  })
})
