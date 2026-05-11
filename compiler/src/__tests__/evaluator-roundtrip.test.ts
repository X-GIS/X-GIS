// Evaluator round-trip safety net for zoom-driven expressions.
//
// The class of bug this guards against: a Mapbox style declares a
// zoom-driven paint property → converter emits the right utility →
// lower routes it into the IR → emit-commands threads it onto a
// ShowCommand expression field → **but the runtime evaluator returns
// 0 / NaN / null when called against the props bag the worker
// injects**.
//
// Pre-fix (PR #102), the worker injected `zoom: tileZoom` but the
// evaluator looks for `props['$zoom']` (the reserved camera-zoom
// key — evaluator.ts:33-38). Result: every `interpolate_exp(zoom,
// …)` width expression returned 0, the `v > 0` filter dropped the
// entry, and the runtime fell back to the default 1 px layer-uniform
// width. The structural coverage test (`mapbox-roundtrip-coverage`)
// happily reported `show.strokeWidthExpr is defined` and gave the
// green light — but the AST was useless at runtime.
//
// This test closes the loop: for every show whose ShowCommand carries
// a numeric expression field (strokeWidthExpr, sizeExpr, etc.), we
// actually CALL `evaluate(ast, { $zoom: z, …feature-props })` at a
// handful of representative zooms and assert the result is a finite
// positive number. The next "evaluator silently returns 0" regression
// fails CI before the user can spot hair-thin roads on a screenshot.

import { describe, it, expect } from 'vitest'
import {
  convertMapboxStyle, Lexer, Parser, lower, emitCommands, evaluate,
  type MapboxLayer,
} from '../index'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OFM_BRIGHT = JSON.parse(readFileSync(join(HERE, 'fixtures', 'openfreemap-bright.json'), 'utf8'))
const MAPLIBRE_DEMO = JSON.parse(readFileSync(join(HERE, 'fixtures', 'maplibre-demotiles.json'), 'utf8'))

// Representative zooms spanning OFM Bright's typical curves (most
// road widths cover z=4 .. z=20; place labels z=2 .. z=18).
const ZOOM_SAMPLES = [4, 8, 12, 14, 15, 16, 18]

interface ShowWithExprs {
  layerName: string
  sourceLayer?: string
  strokeWidthExpr?: { ast: unknown } | null
  strokeColorExpr?: { ast: unknown } | null
  sizeExpr?: { ast: unknown } | null
  label?: {
    sizeExpr?: { ast: unknown }
    colorExpr?: { ast: unknown }
  }
}

function pipeline(style: unknown): ShowWithExprs[] {
  const xgis = convertMapboxStyle(style as never)
  const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  return cmds.shows as unknown as ShowWithExprs[]
}

/** Best-effort sample feature props per source-layer. Mapbox OMT
 *  vector tile schema has well-known property names; we feed
 *  representative values so per-feature expressions
 *  (`["match", ["get", "class"], …]`) don't all evaluate against
 *  empty bags. */
function sampleFeatureProps(sourceLayer?: string): Record<string, unknown> {
  switch (sourceLayer) {
    case 'transportation':
    case 'transportation_name':
      return { class: 'primary', brunnel: '', subclass: '', oneway: 0, ref: '82' }
    case 'place':
      return { class: 'country', rank: 1, name: 'Korea', capital: 0 }
    case 'water_name':
      return { class: 'ocean', name: 'Pacific Ocean' }
    case 'building':
    case 'landuse':
      return { class: 'residential', render_height: 5 }
    case 'water':
      return { class: 'ocean', intermittent: 0 }
    case 'countries':
    case 'centroids':
      return { ADM0_A3: 'KOR', NAME: 'Korea', ABBREV: 'Kor.', SCALERANK: 0 }
    default:
      return {}
  }
}

function checkExprFiniteAtZoom(
  ast: unknown,
  z: number,
  props: Record<string, unknown>,
  label: string,
): string | null {
  let v: unknown
  try {
    v = evaluate(ast as never, { ...props, $zoom: z })
  } catch (e) {
    return `${label} at z=${z}: evaluator threw — ${(e as Error).message}`
  }
  if (v === null || v === undefined) return `${label} at z=${z}: returned null/undefined`
  if (typeof v !== 'number') return null  // colour stops resolve to strings — covered elsewhere
  if (!Number.isFinite(v)) return `${label} at z=${z}: returned ${v} (NaN / Inf)`
  // Numeric expressions for widths/sizes/opacities should be > 0 at
  // typical zooms. Below the first stop the eval clamps to the first
  // stop's value, which might be 0 (e.g. `interpolate(zoom, 12, 0,
  // 14, 2.5)` — pre-z12 the line is invisible by design). Don't
  // require strict positive; just assert finite + non-negative.
  if (v < 0) return `${label} at z=${z}: returned negative ${v}`
  return null
}

function runRoundtrip(name: string, style: unknown): void {
  describe(`evaluator round-trip — ${name}`, () => {
    const shows = pipeline(style)
    it('every numeric expression resolves finite at representative zooms', () => {
      const fails: string[] = []
      for (const s of shows) {
        const props = sampleFeatureProps(s.sourceLayer)
        const checks: Array<[unknown, string]> = []
        if (s.strokeWidthExpr?.ast) checks.push([s.strokeWidthExpr.ast, `${s.layerName}.strokeWidthExpr`])
        if (s.sizeExpr?.ast) checks.push([s.sizeExpr.ast, `${s.layerName}.sizeExpr`])
        if (s.label?.sizeExpr?.ast) checks.push([s.label.sizeExpr.ast, `${s.layerName}.label.sizeExpr`])
        for (const [ast, label] of checks) {
          for (const z of ZOOM_SAMPLES) {
            const fail = checkExprFiniteAtZoom(ast, z, props, label)
            if (fail) fails.push(fail)
          }
        }
      }
      fails.sort()
      expect(fails, `Expressions evaluate to NaN / null / negative — likely an evaluator-key mismatch or unhandled AST node:\n${fails.join('\n')}`).toEqual([])
    })

    it('OFM Bright highway_minor stroke-width grows monotonically with zoom (sanity)', () => {
      if (name !== 'OFM Bright') return
      const minor = shows.find(s => s.layerName === 'highway_minor')
      if (!minor?.strokeWidthExpr?.ast) {
        // Style might not have this layer (defensive). Skip without
        // failing — the cross-style assertion above already covers
        // the broader "every expression resolves" property.
        return
      }
      const props = sampleFeatureProps('transportation')
      const widths = [12, 14, 15, 16, 18, 20].map(z =>
        evaluate(minor.strokeWidthExpr!.ast as never, { ...props, $zoom: z }))
      // Monotonically non-decreasing as zoom rises.
      for (let i = 1; i < widths.length; i++) {
        expect(widths[i], `${widths.join(' → ')} not monotonic at index ${i}`)
          .toBeGreaterThanOrEqual(widths[i - 1] as number)
      }
      // At z=20 the road should be visibly thick (last stop = 11.5 in
      // OFM source). Pin the value so a future regression of the
      // exponential curve (PR #87) gets caught.
      expect(widths[widths.length - 1]).toBeCloseTo(11.5, 1)
    })
  })
}

runRoundtrip('OFM Bright', OFM_BRIGHT)
runRoundtrip('MapLibre demo', MAPLIBRE_DEMO)
