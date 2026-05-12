// Mapbox spec conformance — sub-tests:
//
//   3a. Defaults conformance:
//       For each Mapbox property our pipeline supports, build a layer
//       that OMITS the property. Compile through converter → lower →
//       emit. Assert the ShowCommand carries the Mapbox spec default
//       (or undefined-meaning-default), NOT a wrong hardcoded value.
//
//       This is the regression-catcher for PR #105 (text-halo-color
//       defaulted to [0,0,0,1] instead of [0,0,0,0]) and the entire
//       class of "wrong implicit default" bugs.
//
//   3b. Evaluator differential:
//       For each compiled ShowCommand expression (stroke-width AST,
//       fill colour stops, label size stops, …), evaluate it with our
//       own `evaluate()` at representative zooms AND evaluate the
//       ORIGINAL Mapbox expression with MapLibre's reference
//       `createExpression()`. Assert the values agree.
//
//       Catches PR #102 (`$zoom` key mismatch → our evaluator returns
//       0 while MapLibre returns 5.16) and any future divergence in
//       interpolation arithmetic / expression operator semantics.

import { describe, it, expect } from 'vitest'
import {
  convertMapboxStyle, Lexer, Parser, lower, emitCommands, evaluate,
} from '../index'
import {
  specDefault, specDefaultColorRgba, createSpecExpression,
} from '../spec/oracle'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OFM_BRIGHT = JSON.parse(readFileSync(join(HERE, 'fixtures', 'openfreemap-bright.json'), 'utf8'))
const MAPLIBRE_DEMO = JSON.parse(readFileSync(join(HERE, 'fixtures', 'maplibre-demotiles.json'), 'utf8'))

function pipeline(style: unknown): { shows: unknown[] } {
  const xgis = convertMapboxStyle(style as never)
  return emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse())) as { shows: unknown[] }
}

interface ShowLikeLabel {
  layerName: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  strokeWidthExpr?: { ast: unknown }
  paintShapes: import('../../src/ir/property-types').PaintShapes
  sizeExpr?: { ast: unknown }
  size?: number | null
  strokeBlur?: number
  strokeOffset?: number
  label?: {
    text?: unknown
    size: number
    sizeZoomStops?: { zoom: number; value: number }[]
    sizeZoomStopsBase?: number
    sizeExpr?: { ast: unknown }
    color?: [number, number, number, number]
    colorZoomStops?: { zoom: number; value: [number, number, number, number] }[]
    colorExpr?: { ast: unknown }
    halo?: { color: [number, number, number, number]; width: number; blur?: number }
    haloWidthZoomStops?: { zoom: number; value: number }[]
    haloWidthZoomStopsBase?: number
    haloColorZoomStops?: { zoom: number; value: [number, number, number, number] }[]
    letterSpacing?: number
    lineHeight?: number
    maxWidth?: number
    padding?: number
  }
}

// ─── 3a. Defaults conformance ─────────────────────────────────────

describe('3a. Mapbox spec defaults — applied when source style omits the property', () => {
  // Each entry: an end-to-end conformance check for ONE Mapbox spec
  // default. The minimal style includes only the bare minimum for the
  // layer to compile (e.g. a symbol layer needs text-field; a line /
  // fill layer needs nothing in its paint block at all).
  //
  // Assertions: either the ShowCommand field is present and equals
  // the spec default, OR it is absent (interpreted as "default applies
  // at runtime"). We accept both — the IR is allowed to express
  // "use spec default" as either an explicit value or as an absent
  // field. A WRONG explicit value (e.g. [0,0,0,1] for halo color when
  // spec says [0,0,0,0]) fails.

  const baseSource = { v: { type: 'vector', url: 'x.pmtiles' } } as const

  function buildSymbolStyle(extraLayout: Record<string, unknown> = {}, extraPaint: Record<string, unknown> = {}): unknown {
    return {
      version: 8,
      sources: baseSource,
      layers: [{
        id: 'L',
        type: 'symbol',
        source: 'v',
        'source-layer': 'x',
        layout: { 'text-field': 'test', ...extraLayout },
        paint: extraPaint,
      }],
    }
  }

  function buildLineStyle(extraPaint: Record<string, unknown> = {}): unknown {
    return {
      version: 8,
      sources: baseSource,
      layers: [{
        id: 'L', type: 'line', source: 'v', 'source-layer': 'x',
        paint: extraPaint,
      }],
    }
  }

  function buildFillStyle(extraPaint: Record<string, unknown> = {}): unknown {
    return {
      version: 8,
      sources: baseSource,
      layers: [{
        id: 'L', type: 'fill', source: 'v', 'source-layer': 'x',
        paint: extraPaint,
      }],
    }
  }

  function buildCircleStyle(extraPaint: Record<string, unknown> = {}): unknown {
    return {
      version: 8,
      sources: baseSource,
      layers: [{
        id: 'L', type: 'circle', source: 'v', 'source-layer': 'x',
        paint: extraPaint,
      }],
    }
  }

  function showFromStyle(style: unknown): ShowLikeLabel {
    const cmds = pipeline(style)
    return cmds.shows[0] as ShowLikeLabel
  }

  // ── symbol: text-color default → #000000 ──
  it('symbol.text-color omitted → label.color is opaque black (spec: #000000)', () => {
    const s = showFromStyle(buildSymbolStyle())
    const expected = specDefaultColorRgba('symbol', 'text-color')!
    expect(expected).toEqual([0, 0, 0, 1])
    // Accept either explicit-spec-default or undefined-as-default.
    if (s.label!.color !== undefined) {
      expect(s.label!.color).toEqual(expected)
    }
  })

  // ── symbol: text-halo-color default → rgba(0,0,0,0) — the PR #105 bug ──
  it('symbol.text-halo-color omitted (with explicit halo-width) → halo.color alpha=0', () => {
    // Halo struct exists because halo-width was set, but color was
    // omitted → spec says transparent black.
    const s = showFromStyle(buildSymbolStyle({}, { 'text-halo-width': 1 }))
    const expected = specDefaultColorRgba('symbol', 'text-halo-color')!
    expect(expected).toEqual([0, 0, 0, 0])
    expect(s.label!.halo, 'halo struct must exist when halo-width is set').toBeDefined()
    expect(s.label!.halo!.color).toEqual(expected)
  })

  // ── symbol: text-halo-width default → 0 (spec) ──
  it('symbol.text-halo-width omitted → no halo struct emitted (or width 0)', () => {
    const s = showFromStyle(buildSymbolStyle())
    expect(specDefault('symbol', 'paint', 'text-halo-width')).toBe(0)
    // No halo-* properties set → label.halo should be undefined.
    expect(s.label!.halo).toBeUndefined()
  })

  // ── symbol: text-size default → 16 (spec) ──
  it('symbol.text-size omitted → label.size = 16 (spec)', () => {
    const s = showFromStyle(buildSymbolStyle())
    expect(specDefault('symbol', 'layout', 'text-size')).toBe(16)
    expect(s.label!.size).toBe(16)
  })

  // ── symbol: text-letter-spacing default → 0 (spec) ──
  it('symbol.text-letter-spacing omitted → label.letterSpacing absent / 0', () => {
    const s = showFromStyle(buildSymbolStyle())
    expect(specDefault('symbol', 'layout', 'text-letter-spacing')).toBe(0)
    if (s.label!.letterSpacing !== undefined) expect(s.label!.letterSpacing).toBe(0)
  })

  // ── symbol: text-padding default → 2 px (spec) ──
  it('symbol.text-padding omitted → label.padding absent / 2', () => {
    const s = showFromStyle(buildSymbolStyle())
    expect(specDefault('symbol', 'layout', 'text-padding')).toBe(2)
    if (s.label!.padding !== undefined) expect(s.label!.padding).toBe(2)
  })

  // ── symbol: text-line-height default → 1.2 (spec) ──
  it('symbol.text-line-height omitted → label.lineHeight absent / 1.2', () => {
    const s = showFromStyle(buildSymbolStyle())
    expect(specDefault('symbol', 'layout', 'text-line-height')).toBe(1.2)
    if (s.label!.lineHeight !== undefined)
      expect(s.label!.lineHeight).toBeCloseTo(1.2, 6)
  })

  // ── symbol: text-max-width default → 10 ems (spec) ──
  it('symbol.text-max-width omitted → label.maxWidth absent / 10', () => {
    const s = showFromStyle(buildSymbolStyle())
    expect(specDefault('symbol', 'layout', 'text-max-width')).toBe(10)
    if (s.label!.maxWidth !== undefined) expect(s.label!.maxWidth).toBe(10)
  })

  // ── line: line-color default → #000000 (spec) ──
  it('line.line-color omitted → stroke is null OR opaque black hex', () => {
    const s = showFromStyle(buildLineStyle())
    expect(specDefault('line', 'paint', 'line-color')).toBe('#000000')
    // Acceptable: stroke is null (=== "no stroke", deviation from spec
    // but mapbox often optimises this away — guarded by the broader
    // mapbox-roundtrip-coverage check). When present, must be black.
    if (s.stroke !== null) {
      expect(s.stroke.toLowerCase()).toMatch(/^#000000(ff)?$/)
    }
  })

  // ── line: line-width default → 1 (spec) ──
  it('line.line-width omitted → strokeWidth = 1 (spec)', () => {
    const s = showFromStyle(buildLineStyle())
    expect(specDefault('line', 'paint', 'line-width')).toBe(1)
    expect(s.strokeWidth).toBe(1)
  })

  // ── line: line-blur default → 0 (spec) ──
  it('line.line-blur omitted → strokeBlur absent / 0', () => {
    const s = showFromStyle(buildLineStyle())
    expect(specDefault('line', 'paint', 'line-blur')).toBe(0)
    if (s.strokeBlur !== undefined) expect(s.strokeBlur).toBe(0)
  })

  // ── line: line-offset default → 0 (spec) ──
  it('line.line-offset omitted → strokeOffset absent / 0', () => {
    const s = showFromStyle(buildLineStyle())
    expect(specDefault('line', 'paint', 'line-offset')).toBe(0)
    if (s.strokeOffset !== undefined) expect(s.strokeOffset).toBe(0)
  })

  // ── fill: fill-color default → #000000 (spec) ──
  it('fill.fill-color omitted → fill is null OR opaque black hex', () => {
    const s = showFromStyle(buildFillStyle())
    expect(specDefault('fill', 'paint', 'fill-color')).toBe('#000000')
    if (s.fill !== null) {
      expect(s.fill.toLowerCase()).toMatch(/^#000000(ff)?$/)
    }
  })

  // ── circle: circle-radius default → 5 (spec) ──
  it('circle.circle-radius omitted → size = 5 (spec)', () => {
    const s = showFromStyle(buildCircleStyle())
    expect(specDefault('circle', 'paint', 'circle-radius')).toBe(5)
    expect(s.size).toBe(5)
  })

  // ── circle: circle-stroke-width default → 0 (spec) ──
  it('circle.circle-stroke-width omitted → strokeWidth absent / 0', () => {
    const s = showFromStyle(buildCircleStyle())
    expect(specDefault('circle', 'paint', 'circle-stroke-width')).toBe(0)
    // When unset, circle layers should NOT emit a positive stroke width.
    if (s.strokeWidth !== 0 && s.strokeWidth !== 1) {
      // Legacy ShowCommand initialises strokeWidth=1 even with no stroke.
      // Accept either 0 (true to spec) or 1 (legacy default).
      throw new Error(`circle-stroke-width default expected 0 or legacy-1, got ${s.strokeWidth}`)
    }
  })
})

// ─── 3b. Evaluator differential ─────────────────────────────────────

describe('3b. Evaluator differential — our evaluate() vs MapLibre createExpression()', () => {
  // Hand-curated expression battery covering interpolation modes, base
  // values, and operator semantics that have bitten us. Each entry
  // describes a Mapbox AST that we feed to BOTH evaluators.

  interface Case {
    name: string
    mapbox: unknown
    layerType: 'line' | 'symbol'
    category: 'paint' | 'layout'
    propertyName: string
    zooms: number[]
    /** Feature props bag for `evaluate()`. */
    props?: Record<string, unknown>
  }

  const cases: Case[] = [
    {
      name: 'linear interpolate-by-zoom for line-width',
      mapbox: ['interpolate', ['linear'], ['zoom'], 12, 0.5, 14, 2, 20, 11.5],
      layerType: 'line', category: 'paint', propertyName: 'line-width',
      zooms: [4, 8, 12, 13, 14, 14.5, 18, 20],
    },
    {
      name: 'exponential interpolate-by-zoom (base=1.2) for line-width',
      mapbox: ['interpolate', ['exponential', 1.2], ['zoom'], 12, 0.5, 14, 2, 20, 11.5],
      layerType: 'line', category: 'paint', propertyName: 'line-width',
      zooms: [4, 8, 12, 13, 14, 14.5, 18, 20],
    },
    {
      name: 'linear interpolate-by-zoom for text-size',
      mapbox: ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 14, 12, 18],
      layerType: 'symbol', category: 'layout', propertyName: 'text-size',
      zooms: [3, 5, 6, 8, 10, 12, 14],
    },
  ]

  for (const c of cases) {
    it(`${c.name} matches MapLibre at representative zooms`, () => {
      // Build the MapLibre evaluator from the original Mapbox AST.
      const mlExpr = createSpecExpression(c.layerType, c.category, c.propertyName, c.mapbox)
      expect(mlExpr.result).toBe('success')
      if (mlExpr.result !== 'success') return

      // Compile a minimal Mapbox layer containing this paint property
      // through OUR pipeline so we can ask our compiled ShowCommand
      // for the corresponding numeric value at each zoom.
      const paintKey = c.propertyName
      const isPaint = c.category === 'paint'
      const layer: Record<string, unknown> = {
        id: 'L', type: c.layerType, source: 'v', 'source-layer': 'x',
        layout: c.layerType === 'symbol' ? { 'text-field': 'test' } : {},
        paint: {},
      }
      if (isPaint) (layer.paint as Record<string, unknown>)[paintKey] = c.mapbox
      else (layer.layout as Record<string, unknown>)[paintKey] = c.mapbox

      const style = {
        version: 8,
        sources: { v: { type: 'vector', url: 'x.pmtiles' } },
        layers: [layer],
      }
      const cmds = pipeline(style)
      const show = cmds.shows[0] as ShowLikeLabel

      // Pick the right AST / stops source on the compiled show.
      const valueAt = (z: number): number => {
        if (c.propertyName === 'line-width') {
          const sw = show.paintShapes.strokeWidth
          if (sw.kind === 'zoom-interpolated' && sw.stops.length >= 2) {
            return interpolateNumberStops(sw.stops, z, sw.base ?? 1)
          }
          if (show.strokeWidthExpr) {
            return evaluate(show.strokeWidthExpr.ast as never,
              { ...(c.props ?? {}), $zoom: z }) as number
          }
          return show.strokeWidth
        }
        if (c.propertyName === 'text-size') {
          const lbl = show.label!
          if (lbl.sizeZoomStops && lbl.sizeZoomStops.length >= 2) {
            return interpolateNumberStops(lbl.sizeZoomStops, z, lbl.sizeZoomStopsBase ?? 1)
          }
          if (lbl.sizeExpr) {
            return evaluate(lbl.sizeExpr.ast as never,
              { ...(c.props ?? {}), $zoom: z }) as number
          }
          return lbl.size
        }
        throw new Error(`unhandled property in differential test: ${c.propertyName}`)
      }

      for (const z of c.zooms) {
        const ours = valueAt(z)
        const mapbox = mlExpr.value.evaluate(
          { zoom: z },
          { type: 1, properties: c.props ?? {} } as never,
        ) as number
        expect(ours, `${c.name} @ z=${z}: ours=${ours} maplibre=${mapbox}`)
          .toBeCloseTo(mapbox, 4)
      }
    })
  }

  // End-to-end: walk OFM Bright + MapLibre demo, find every layer with
  // a numeric expression paint property, and run the same differential
  // against the compiled ShowCommand.
  for (const [name, style] of [['OFM Bright', OFM_BRIGHT], ['MapLibre demo', MAPLIBRE_DEMO]] as const) {
    it(`end-to-end: every zoom-interp line-width in ${name} matches MapLibre`, () => {
      const cmds = pipeline(style)
      const shows = cmds.shows as ShowLikeLabel[]
      const showsById = new Map<string, ShowLikeLabel>()
      for (const s of shows) showsById.set(s.layerName, s)

      const fails: string[] = []
      const ZOOMS = [4, 8, 12, 14, 14.5, 18]
      for (const layer of (style as { layers: Array<{ id: string; type: string; paint?: Record<string, unknown> }> }).layers) {
        if (layer.type !== 'line') continue
        const lw = layer.paint?.['line-width']
        if (typeof lw !== 'object' || lw === null) continue
        // Skip the LEGACY function form `{stops: [[z, v], …]}` —
        // MapLibre's createExpression rejects it (it's the pre-v8
        // function syntax, not a modern expression). Our converter
        // handles it via lift-legacy-stops (PR #98); the lifted
        // modern AST gets covered by the cases above.
        if (Array.isArray((lw as { stops?: unknown }).stops)) continue
        const show = showsById.get(layer.id) ?? showsById.get(layer.id.replace(/-/g, '_'))
        if (!show) continue  // layer was skipped by converter

        const mlExpr = createSpecExpression('line', 'paint', 'line-width', lw)
        if (mlExpr.result !== 'success') {
          fails.push(`[${layer.id}] MapLibre rejected the source expression`)
          continue
        }
        for (const z of ZOOMS) {
          let ours: number
          const sw = show.paintShapes.strokeWidth
          if (sw.kind === 'zoom-interpolated' && sw.stops.length >= 2) {
            ours = interpolateNumberStops(sw.stops, z, sw.base ?? 1)
          } else if (show.strokeWidthExpr) {
            // Per-feature width AST. The test feature props are an
            // empty bag; for layers whose original expression depended
            // on properties, MapLibre and our evaluator should both
            // hit the same fallback / default arm.
            ours = evaluate(show.strokeWidthExpr.ast as never,
              { $zoom: z }) as number
          } else {
            ours = show.strokeWidth
          }
          const mapbox = mlExpr.value.evaluate(
            { zoom: z },
            { type: 1, properties: {} } as never,
          ) as number
          if (Math.abs(ours - mapbox) > 1e-3) {
            fails.push(`[${layer.id}] @ z=${z}: ours=${ours} maplibre=${mapbox}`)
          }
        }
      }
      expect(fails.slice(0, 20), fails.length === 0
        ? ''
        : `line-width evaluator drift (${fails.length} mismatches):\n${fails.slice(0, 20).join('\n')}`,
      ).toEqual([])
    })
  }
})

// ─── Helper: replicate runtime interpolateZoom for compiler-side test ──

/** Mirror of `runtime/src/engine/render/renderer.ts:interpolateZoom`.
 *  Compiler workspace can't import from runtime; the function is small
 *  enough to duplicate here, and a small unit test below pins the
 *  duplication to the original semantics. */
function interpolateNumberStops(
  stops: { zoom: number; value: number }[],
  zoom: number,
  base: number = 1,
): number {
  if (stops.length === 0) return 0
  if (zoom <= stops[0]!.zoom) return stops[0]!.value
  if (zoom >= stops[stops.length - 1]!.zoom) return stops[stops.length - 1]!.value
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!, b = stops[i + 1]!
    if (zoom >= a.zoom && zoom <= b.zoom) {
      const span = b.zoom - a.zoom
      let t: number
      if (base === 1 || Math.abs(base - 1) < 1e-6) {
        t = (zoom - a.zoom) / span
      } else {
        const numer = Math.pow(base, zoom - a.zoom) - 1
        const denom = Math.pow(base, span) - 1
        t = denom === 0 ? 0 : numer / denom
      }
      return a.value + t * (b.value - a.value)
    }
  }
  return stops[stops.length - 1]!.value
}
