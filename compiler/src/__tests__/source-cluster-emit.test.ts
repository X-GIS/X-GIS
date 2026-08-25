// #2050 (T3 clustering, design §5 P1) — a GeoJSON source's clustering declaration must
// REACH the IR instead of being warned away, and `["accumulated"]` must become a
// reserved evaluator identifier.
//
// The gap this closes, one property family over from #1983 (tileSize/maxzoom/minzoom),
// #1984 (bounds) and #1985 (scheme):
//
//   • the converter DETECTED `cluster` / `clusterRadius` / `clusterMaxZoom` /
//     `clusterMinPoints` / `clusterProperties` and dropped ALL five with one warning
//     telling the author to pre-cluster at the host;
//   • `lowerSource` claimed none of the keys, so a hand-authored `clusterRadius: 50`
//     fell into the custom-loader options bag (a number nothing reads) and
//     `clusterProperties: {…}` was silently discarded (the options bag collects only
//     String/Number/Array literals);
//   • and `["accumulated"]` — the accessor the whole `clusterProperties` reduce form
//     exists for — converted to nothing at all.
//
// GRAMMAR: ZERO new productions, names and values alike (measured against the real Lexer
// + Parser; every claim below is pinned by a test in this file).
//   • the NAMES are camelCase, spelled exactly as Mapbox's own source spec spells them
//     and exactly as every other source-block key already is (`sourceLayer`, `tileSize`,
//     `redFactor`, `baseShift`). `parseBlockProperty` reads ONE identifier for a name, so
//     that is the spelling the grammar already accepts. The hyphenated form belongs to
//     `parseStyleProperty` — the LAYER-paint shape — and `clusterRadius:`' hyphenated
//     twin is still a syntax error (`Expected Colon, got Minus`), pinned in W2 so nobody
//     widens the block-property grammar for a spelling the language does not use.
//   • the VALUES parse as full expressions: `cluster: true` arrives as `BoolLiteral`,
//     `clusterRadius: 50` as `NumberLiteral`, and the nested
//     `{ k: { map: <expr>, reduce: <expr> } }` map as an `ObjectLiteral` whose values are
//     parsed with `parseExpr()` — `.mag` is a `FieldAccess`, `accumulated + .mag_sum` a
//     `BinaryExpr`, `max(accumulated, .m)` an `FnCall`. Nested object literals already
//     exist for inline `data:` GeoJSON.
//
// ASTs, NOT `astLiteralToJS`. `clusterProperties` carries a PAIR of xgis expressions per
// key (design §4.3), and `astLiteralToJS` is a literal-only walker that THROWS on a
// `FieldAccess` — so the lowering keeps `AST.Expr` nodes, the one place `data:`'s
// precedent does not apply. Pinned by evaluating a lowered `map` expression.
//
// P1 IS CONVERTER + COMPILER ONLY. The tiler cluster index (P2) and the worker/pool
// wiring (P3) are not in this phase, so the converter keeps a NARROWED warning saying
// the options are carried but not yet clustered (design §7) — at no point between P1 and
// P4 does a clustered style convert with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower } from '..'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'
import { exprToXgis } from '../convert/expressions'
import { parseExpressionString } from '../parser/parser'
import { withPragma } from './_pragma'

/** Parse + lower only — the IR `Scene`. P1 stops at `SourceDef`; the `LoadCommand`
 *  pass-through and the runtime read are P3, so nothing here asserts past the IR. */
const toScene = (src: string) => lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse())

function convert(style: unknown): { code: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, warnings: coverage.warnings }
}

/** The emitted `source <id> { … }` block, verbatim. Line-scanned rather than
 *  regex-matched: URL templates carry literal `{z}/{x}/{y}` braces. */
function sourceBlock(code: string, id: string): string {
  const lines = code.split('\n')
  const start = lines.indexOf(`source ${id} {`)
  expect(start, `no source block for "${id}" in:\n${code}`).toBeGreaterThanOrEqual(0)
  const end = lines.indexOf('}', start)
  return lines.slice(start, end + 1).join('\n')
}

const geoStyle = (extra: Record<string, unknown>) => ({
  version: 8,
  sources: {
    quakes: { type: 'geojson', data: 'https://example.com/quakes.geojson', ...extra },
  },
  layers: [{ id: 'c', type: 'circle', source: 'quakes' }],
})

const clusterWarnings = (w: string[]) => w.filter((s) => s.toLowerCase().includes('cluster'))

const FULL = {
  cluster: true,
  clusterRadius: 80,
  clusterMaxZoom: 14,
  clusterMinPoints: 3,
  clusterProperties: { mag_sum: ['+', ['get', 'mag']] },
}

describe('#2050 W1 — the converter EMITS the cluster options instead of dropping them', () => {
  it('every declared option reaches the xgis source block', () => {
    const lines = sourceBlock(convert(geoStyle(FULL)).code, 'quakes').split('\n')
    expect(lines).toContain('  cluster: true')
    expect(lines).toContain('  clusterRadius: 80')
    expect(lines).toContain('  clusterMaxZoom: 14')
    expect(lines).toContain('  clusterMinPoints: 3')
    expect(lines).toContain(
      '  clusterProperties: { "mag_sum": { map: .mag, reduce: (accumulated + .mag_sum) } }',
    )
  })

  it('the retired drop-warning is GONE — nobody is told to pre-cluster at the host', () => {
    const { warnings } = convert(geoStyle(FULL))
    expect(warnings.some((s) => s.includes('no point-clustering pipeline'))).toBe(false)
    expect(warnings.some((s) => s.includes('Pre-cluster the data at the host'))).toBe(false)
    expect(warnings.some((s) => s.includes('render at their authored positions'))).toBe(false)
  })

  it('P1 still says the source is CARRIED but not yet clustered (design §7)', () => {
    // The intermediate state is warning-backed on purpose: the emit lands three phases
    // before the runtime that reads it. P4 shrinks this to the real residue.
    const w = clusterWarnings(convert(geoStyle(FULL)).warnings)
    expect(w.length).toBe(1)
    expect(w[0]).toContain('"quakes"')
    expect(w[0]).toContain('no cluster index')
  })

  it('a geojson source that declares NO clustering emits nothing and warns nothing', () => {
    const { code, warnings } = convert(geoStyle({}))
    expect(sourceBlock(code, 'quakes')).not.toContain('cluster')
    expect(clusterWarnings(warnings)).toEqual([])
  })

  it('`cluster: false` is the default — byte-identical to declaring nothing', () => {
    // The regression guard the byte-identity invariant rests on: an existing style
    // must convert unchanged.
    const declared = convert(geoStyle({ cluster: false }))
    const omitted = convert(geoStyle({}))
    expect(declared.code).toBe(omitted.code)
    expect(declared.warnings).toEqual(omitted.warnings)
  })

  it('tuning options WITHOUT `cluster: true` are inert — warned, never emitted', () => {
    // MapLibre reads clusterRadius/clusterMaxZoom/… only when `cluster` is true, so
    // emitting them here would be a line nothing can ever read.
    const { code, warnings } = convert(geoStyle({ clusterRadius: 80, clusterMaxZoom: 14 }))
    expect(sourceBlock(code, 'quakes')).not.toContain('clusterRadius')
    const w = clusterWarnings(warnings)
    expect(w.length).toBe(1)
    expect(w[0]).toContain('without `cluster: true`')
  })
})

describe('#2050 W2 — the five keys are RESERVED source-block properties', () => {
  const HAND =
    'source quakes {\n' +
    '  type: geojson\n' +
    '  url: "https://example.com/quakes.geojson"\n' +
    '  cluster: true\n' +
    '  clusterRadius: 80\n' +
    '  clusterMaxZoom: 14\n' +
    '  clusterMinPoints: 3\n' +
    '  clusterProperties: { mag_sum: { map: .mag, reduce: accumulated + .mag_sum } }\n' +
    '}\n' +
    'layer l { source: quakes }'

  it('GRAMMAR: the whole block parses with no new production, values and all', () => {
    // The camelCase names are what `parseBlockProperty`'s single-identifier name rule
    // already accepts; the values ride the block-property expression grammar untouched.
    const stmt = new Parser(new Lexer(withPragma(HAND)).tokenize()).parse().body[0] as {
      properties: { name: string; value: { kind: string } }[]
    }
    expect(stmt.properties.map((p) => `${p.name}=${p.value.kind}`)).toEqual([
      'type=Identifier',
      'url=StringLiteral',
      'cluster=BoolLiteral',
      'clusterRadius=NumberLiteral',
      'clusterMaxZoom=NumberLiteral',
      'clusterMinPoints=NumberLiteral',
      'clusterProperties=ObjectLiteral',
    ])
  })

  it('the HYPHENATED twin stays a syntax error — the layer-paint form, not this one', () => {
    // Pins the un-widening: `parseBlockProperty` reads ONE identifier for a name, and
    // hyphen-joining belongs to `parseStyleProperty`. If a later change widens the
    // block-property grammar, this reds and the reviewer gets to ask why.
    expect(() =>
      toScene('source s { type: geojson, cluster-radius: 50 }\nlayer l { source: s }'),
    ).toThrow(/Expected Colon, got Minus/)
  })

  it('CAUSE: lowerSource lands the four scalars on the IR SourceDef', () => {
    const src = toScene(HAND).sources.find((s) => s.name === 'quakes')
    expect(src?.cluster).toBe(true)
    expect(src?.clusterRadius).toBe(80)
    expect(src?.clusterMaxZoom).toBe(14)
    expect(src?.clusterMinPoints).toBe(3)
  })

  it('clusterProperties holds AST NODES, not astLiteralToJS output', () => {
    // `astLiteralToJS` THROWS on a FieldAccess ("inline `data` must be literal
    // GeoJSON"), so routing this through it could not even produce a value — the
    // pair must survive as parsed expressions all the way to the worker (design §4.3).
    const src = toScene(HAND).sources.find((s) => s.name === 'quakes')
    const entry = src?.clusterProperties?.mag_sum
    expect(entry?.map.kind).toBe('FieldAccess')
    expect(entry?.reduce.kind).toBe('BinaryExpr')
  })

  it('the carried ASTs EVALUATE — the map reads the point, the reduce accumulates', () => {
    // The distinguishing assertion: a shape check alone would pass on any AST node.
    // This runs the two expressions the P3 worker will run.
    const entry = toScene(HAND).sources.find((s) => s.name === 'quakes')?.clusterProperties?.mag_sum
    expect(evaluate(entry!.map, { mag: 4.5 })).toBe(4.5)
    expect(evaluate(entry!.reduce, makeEvalProps({ props: { mag_sum: 2 }, accumulated: 40 }))).toBe(
      42,
    )
  })

  it('none of the five leaks into the custom-loader options bag', () => {
    // The #1985 side hole, closed on arrival: an unclaimed source key lands in
    // `options` where nothing reads it.
    const src = toScene(HAND).sources.find((s) => s.name === 'quakes')
    for (const k of [
      'cluster',
      'clusterRadius',
      'clusterMaxZoom',
      'clusterMinPoints',
      'clusterProperties',
    ]) {
      expect(src?.options?.[k]).toBeUndefined()
    }
  })

  it('ROUND TRIP: the converter output re-parses onto the same SourceDef fields', () => {
    const { code } = convert(geoStyle(FULL))
    const src = lower(new Parser(new Lexer(code).tokenize()).parse()).sources.find(
      (s) => s.name === 'quakes',
    )
    expect(src?.cluster).toBe(true)
    expect(src?.clusterRadius).toBe(80)
    expect(src?.clusterMaxZoom).toBe(14)
    expect(src?.clusterMinPoints).toBe(3)
    expect(evaluate(src!.clusterProperties!.mag_sum.map, { mag: 4.5 })).toBe(4.5)
  })

  it('a source declaring no clustering carries no cluster fields at all', () => {
    const src = toScene(
      'source plain { type: geojson, url: "https://x/a.geojson" }\nlayer l { source: plain }',
    ).sources.find((s) => s.name === 'plain')
    expect(src?.cluster).toBeUndefined()
    expect(src?.clusterRadius).toBeUndefined()
    expect(src?.clusterProperties).toBeUndefined()
  })
})

describe('#2050 W3 — `["accumulated"]` is a reserved evaluator identifier', () => {
  it('CAUSE: the converter lowers ["accumulated"] to the bare identifier, no warning', () => {
    const warnings: string[] = []
    expect(exprToXgis(['accumulated'], warnings)).toBe('accumulated')
    expect(warnings).toEqual([])
  })

  it('EFFECT: `accumulated + .x` reads the INJECTED reserved key', () => {
    // The cut that matters: a feature property literally NAMED `accumulated` must not
    // shadow the injected running value — that is the difference between reading the
    // reserved key and reading the ordinary props bag.
    const expr = parseExpressionString('accumulated + .x')
    const props = makeEvalProps({ props: { x: 2, accumulated: 999 }, accumulated: 40 })
    expect(evaluate(expr, props)).toBe(42)
  })

  it('with nothing injected it resolves to null — the zoom / pitch proxy contract', () => {
    expect(evaluate(parseExpressionString('accumulated'), {})).toBe(null)
  })
})

describe('#2050 W4 — clusterProperties: both MapLibre operator forms convert', () => {
  it('the bare-operator form expands to [op, ["accumulated"], ["get", key]]', () => {
    const block = sourceBlock(
      convert(geoStyle({ cluster: true, clusterProperties: { max_h: ['max', ['get', 'h']] } }))
        .code,
      'quakes',
    )
    expect(block).toContain('"max_h": { map: .h, reduce: max(accumulated, .max_h) }')
  })

  it('the two-element FULL form passes its reduce through verbatim', () => {
    const block = sourceBlock(
      convert(
        geoStyle({
          cluster: true,
          clusterProperties: {
            worst: [
              ['max', ['accumulated'], ['get', 'worst']],
              ['get', 'sev'],
            ],
          },
        }),
      ).code,
      'quakes',
    )
    expect(block).toContain('"worst": { map: .sev, reduce: max(accumulated, .worst) }')
  })

  it('several keys share one line, in declaration order', () => {
    const block = sourceBlock(
      convert(
        geoStyle({
          cluster: true,
          clusterProperties: { a: ['+', ['get', 'x']], b: ['max', ['get', 'y']] },
        }),
      ).code,
      'quakes',
    )
    expect(block).toContain(
      '  clusterProperties: { "a": { map: .x, reduce: (accumulated + .a) }, ' +
        '"b": { map: .y, reduce: max(accumulated, .b) } }',
    )
  })

  it('a malformed entry is DROPPED with its own clause; its siblings survive', () => {
    const { code, warnings } = convert(
      geoStyle({
        cluster: true,
        clusterProperties: { good: ['+', ['get', 'x']], bad: 'not-a-pair' },
      }),
    )
    const block = sourceBlock(code, 'quakes')
    expect(block).toContain('"good": { map: .x, reduce: (accumulated + .good) }')
    expect(block).not.toContain('"bad"')
    const w = warnings.filter((s) => s.includes('clusterProperties'))
    expect(w.length).toBe(1)
    expect(w[0]).toContain('"bad"')
  })

  it('an unconvertible map expression drops that key only', () => {
    const { code, warnings } = convert(
      geoStyle({
        cluster: true,
        clusterProperties: {
          good: ['+', ['get', 'x']],
          gone: ['+', ['feature-state', 'hover']],
        },
      }),
    )
    expect(sourceBlock(code, 'quakes')).not.toContain('"gone"')
    expect(warnings.some((s) => s.includes('clusterProperties') && s.includes('"gone"'))).toBe(true)
  })

  it('every key dropped → no clusterProperties line at all, cluster still emitted', () => {
    const block = sourceBlock(
      convert(geoStyle({ cluster: true, clusterProperties: { bad: 7 } })).code,
      'quakes',
    )
    expect(block).toContain('  cluster: true')
    expect(block).not.toContain('clusterProperties')
  })
})
