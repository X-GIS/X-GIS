// Where the pattern properties' support boundary actually sits (#2380).
//
// `fill-pattern`, `line-pattern` and `fill-extrusion-pattern` accept a CONSTANT
// sprite name, and — since #2380 INC-0 — a `match()` over sprite names, which the
// converter splits into one sublayer per unique sprite so each carries the
// constant form. Every other expression form is still declined with a warning.
//
// That boundary had NO test at all before this file: the warning strings appear
// only in `paint-fill.ts` / `paint-line.ts` / `paint-fill-extrusion.ts` and
// nowhere under a `*.test.ts`, so nothing pinned which forms convert and which
// fall back — which is part of why the three spec-coverage rows read
// `status: 'supported'` while the note said constant-only.
//
// It pins the boundary in BOTH directions on purpose: an assertion that only
// checked the warning could not tell "this form is declined" from "the converter
// warns about everything", and one that only checked the emit could not tell a
// real split from a layer that merely mentioned three sprite names.
//
// THE SPLIT IS NOT A SHADER CHANGE, and an earlier draft of this comment said it
// was. There is no per-feature variant and no UV-bbox palette here: each
// sublayer draws a constant pattern through the pipelines that already existed.
// The variant route was considered and rejected — it needs a per-feature REPEAT
// as well as a bbox (sprite sizes differ, and repeat is recomputed per frame from
// camera zoom), and an atlas of bboxes hits `rhiVariantFillSupported`'s r32float
// fence and fails to LINK on WebGL2 rather than drawing wrong.
//
// The `["get"]` arms below stay declined — INC-1, and a different risk rather
// than a bigger version of this one: an open-ended key set has no compile-time
// sprite list to split on, so it needs the hashed 23-bit `stableCategoryId`
// palette path and the collision question that comes with it.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from './mapbox-to-xgis'

function emptyCoverage(): StyleCoverage {
  return { sources: [], layers: [], warnings: [] }
}

/** Convert a one-layer style and return both halves of the result: the emitted
 *  source and the warnings. Both matter — a property can be declined loudly
 *  (a warning) or silently (absent from the emit), and only reading both
 *  separates them. */
function convertLayer(layer: Record<string, unknown>): { src: string; warnings: string[] } {
  const coverage = emptyCoverage()
  const src = convertMapboxStyle(
    {
      version: 8,
      name: 'pattern-dd',
      sources: { s: { type: 'vector', url: 'https://example.invalid/tiles.json' } },
      layers: [layer],
    } as never,
    { coverage },
  )
  return { src, warnings: coverage.warnings }
}

const PATTERN_CASES = [
  {
    property: 'fill-pattern',
    layer: (v: unknown) => ({
      id: 'L',
      type: 'fill',
      source: 's',
      'source-layer': 'sl',
      paint: { 'fill-pattern': v },
    }),
    emitToken: 'fill-pattern-hatch',
  },
  {
    property: 'line-pattern',
    layer: (v: unknown) => ({
      id: 'L',
      type: 'line',
      source: 's',
      'source-layer': 'sl',
      paint: { 'line-pattern': v },
    }),
    // NOT `line-pattern-hatch`: the line property lowers to the STROKE family
    // (`stroke-image-<name>`), while fill and fill-extrusion both emit
    // `fill-pattern-<name>`. Guessed wrong first; the control arm caught it.
    emitToken: 'stroke-image-hatch',
  },
  {
    property: 'fill-extrusion-pattern',
    layer: (v: unknown) => ({
      id: 'L',
      type: 'fill-extrusion',
      source: 's',
      'source-layer': 'sl',
      paint: { 'fill-extrusion-pattern': v },
    }),
    emitToken: 'fill-pattern-hatch',
  },
] as const

describe('#2380 — pattern properties: constant and match() convert, other expressions decline', () => {
  // The CONTROL arm. Without it the declining arms below carry no information:
  // a converter that warned on every form, or emitted nothing for any form,
  // would satisfy them just as well.
  for (const { property, layer, emitToken } of PATTERN_CASES) {
    it(`${property}: a constant sprite name converts, with no warning`, () => {
      const { src, warnings } = convertLayer(layer('hatch'))
      expect(src).toContain(emitToken)
      expect(warnings.filter((w) => w.includes(property))).toEqual([])
    })
  }

  // The SUBJECT arms — INC-0. Fail-before: every one of these asserted
  // `non-constant form` and passed, because the decline WAS the behaviour.
  for (const { property, layer, emitToken } of PATTERN_CASES) {
    it(`${property}: a match() over sprite names splits into constant-pattern sublayers`, () => {
      const { src, warnings } = convertLayer(
        layer([
          'match',
          ['get', 'kind'],
          'wood',
          'hatch-wood',
          'water',
          'hatch-water',
          'hatch-default',
        ]),
      )
      // No decline: each sublayer carries a CONSTANT sprite name by the time
      // it reaches paint-*.ts, so the non-constant branch is never taken.
      expect(warnings.filter((w) => w.includes('non-constant form'))).toEqual([])

      // Every arm reaches the emit, the default one included — a split that
      // dropped the default would silently lose every unmatched feature.
      const prefix = emitToken.replace(/hatch$/, '')
      for (const sprite of ['hatch-wood', 'hatch-water', 'hatch-default']) {
        expect(src).toContain(`${prefix}${sprite}`)
      }

      // …and they are SEPARATE sublayers, not one layer that happened to
      // mention three names. Without this the assertion above would pass on an
      // emit that concatenated the arms into a single unusable declaration.
      expect(src).toContain('L__c0')
      expect(src).toContain('L__cd')
    })
  }

  // A one-arm match still splits, unlike the colour case. `minDistinct` is 1
  // for pattern precisely because bailing here would fall through to the
  // decline and lose the default sprite entirely.
  it('fill-pattern: a single-arm match still separates the explicit and default sprites', () => {
    const { src, warnings } = convertLayer(
      PATTERN_CASES[0].layer(['match', ['get', 'kind'], 'wood', 'hatch-wood', 'hatch-default']),
    )
    expect(warnings.filter((w) => w.includes('non-constant form'))).toEqual([])
    expect(src).toContain('fill-pattern-hatch-wood')
    expect(src).toContain('fill-pattern-hatch-default')
  })

  // The OPEN-ENDED form — INC-1, deliberately still declined after INC-0.
  for (const { property, layer } of PATTERN_CASES) {
    it(`${property}: a bare ["get"] is declined with a warning (stays declined until INC-1)`, () => {
      const { warnings } = convertLayer(layer(['get', 'pattern']))
      const mine = warnings.filter((w) => w.includes(property))
      expect(mine).toHaveLength(1)
      expect(mine[0]).toContain('non-constant form')
    })
  }

  // The fallback the warning PROMISES. "The layer falls back to fill-color or
  // transparent" is a claim about the emit, not just about the message, and a
  // reader acting on the warning needs it to be true.
  it('fill-pattern: a declined expression leaves the authored fill-color intact', () => {
    const { src, warnings } = convertLayer({
      id: 'L',
      type: 'fill',
      source: 's',
      'source-layer': 'sl',
      paint: { 'fill-pattern': ['get', 'pattern'], 'fill-color': '#ff0000' },
    })
    expect(warnings.some((w) => w.includes('fill-pattern'))).toBe(true)
    expect(src).not.toContain('fill-pattern-')
    expect(src.toLowerCase()).toContain('ff0000')
  })
})
