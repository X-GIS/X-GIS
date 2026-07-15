// ═══ #1067 — single registry authority for the utility micro-grammar ═══
//
// Three contracts, matching the issue:
//   1. COMPLETENESS — every prefix the old `startsWith` ladders handled is in
//      the table; lowering produces the same command shapes as before
//      (representative utilities per value-kind), longest-match is
//      order-independent, and every prefix used across the example corpus is
//      known (no X-GIS0013 over the whole corpus).
//   2. UNKNOWN = ERROR everywhere — `colr-red` / `opacty-50` raise an
//      X-GIS0013 error with nearest-name help in BOTH normal lowering and
//      inside a `keyframes` block. (fail-before: keyframe expansion used to
//      silently ignore unknown frame utilities — lower-animation.ts.)
//   3. OPACITY — `opacity-50` = 0.5, `opacity-100` = 1, `opacity-[0.33]` = 0.33;
//      the old `opacity-1` == 1.0 cliff is gone (now 0.01, the 0..100 scale).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { resolveUtilities } from '../ir/utility-resolver'
import { UTILITY_REGISTRY, classifyUtility } from '../ir/utility-registry'
import { withPragma } from './_pragma'

function compile(src: string) {
  return lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse())
}
function layerFor(utilities: string) {
  return compile(
    `source d { type: geojson, url: "x.geojson" }\nlayer l { source: d | ${utilities} }`,
  ).renderNodes[0]
}
function diagnosticsFor(src: string, code = 'X-GIS0013') {
  return (compile(src).diagnostics ?? []).filter((d) => d.code === code)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLES_DIR = join(HERE, '..', '..', '..', 'playground', 'src', 'examples')
const xgisFiles = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.xgis') || f.endsWith('.xgs'))

// ─────────────────────────────────────────────────────────────────────────
// 1. Registry completeness + longest-match
// ─────────────────────────────────────────────────────────────────────────
describe('#1067 registry — completeness & order-independent longest-match', () => {
  it('every registry entry is reachable — its own prefix classifies back to it', () => {
    for (const d of UTILITY_REGISTRY) {
      const sample = d.match === 'exact' ? d.prefix : `${d.prefix}q9`
      const hit = classifyUtility(sample)
      expect(hit, `no classification for sample "${sample}" (entry "${d.prefix}")`).toBeDefined()
      expect(hit!.prefix, `"${sample}" must longest-match entry "${d.prefix}"`).toBe(d.prefix)
    }
  })

  it('longer prefixes win over shorter (the text-halo- vs text- ladder subtlety)', () => {
    expect(classifyUtility('stroke-dashoffset-5')!.prefix).toBe('stroke-dashoffset-')
    expect(classifyUtility('stroke-amber-300')!.prefix).toBe('stroke-')
    expect(classifyUtility('fill-pattern-dot')!.prefix).toBe('fill-pattern-')
    expect(classifyUtility('fill-red-500')!.prefix).toBe('fill-')
    expect(classifyUtility('fill-extrusion-height-40')!.prefix).toBe('fill-extrusion-height-')
    expect(classifyUtility('stroke-offset-right-3')!.prefix).toBe('stroke-offset-right-')
    expect(classifyUtility('stroke-offset-3')!.prefix).toBe('stroke-offset-')
    expect(classifyUtility('heatmap-opacity-0.9')!.prefix).toBe('heatmap-opacity-')
  })

  // Representative lowering per value-kind — same command shapes as the old ladders.
  it('color: fill-<color> / stroke-<color> lower to constant colours', () => {
    const n = layerFor('fill-red-500 stroke-blue-500')
    expect(n.fill.kind).toBe('constant')
    expect(n.stroke.color.kind).toBe('constant')
  })
  it('number: opacity / size / stroke-width lower to constants', () => {
    const n = layerFor('opacity-50 size-8 stroke-4')
    expect(n.opacity).toMatchObject({ kind: 'constant', value: 0.5 })
    expect(n.size).toMatchObject({ kind: 'constant', value: 8 })
    expect(n.stroke.width).toMatchObject({ kind: 'constant', value: 4 })
  })
  it('enum: stroke cap + projection', () => {
    const n = layerFor('stroke-round-cap projection-mercator')
    expect(n.stroke.linecap).toBe('round')
    expect(n.projection).toBe('mercator')
  })
  it('boolean: hidden / flat', () => {
    const n = layerFor('hidden flat')
    expect(n.visible).toBe(false)
    expect(n.billboard).toBe(false)
  })
  it('string: fill-pattern-<name>', () => {
    const n = layerFor('fill-slate-500 fill-pattern-dot')
    expect(n.fillPattern).toBe('dot')
  })
  it('expr: size-[<feature-expr>] stays data-driven', () => {
    expect(layerFor('size-[speed * 2]').size.kind).toBe('data-driven')
  })

  it('every utility-form prefix used across the example corpus is known (0 × X-GIS0013)', () => {
    const offenders: string[] = []
    for (const file of xgisFiles) {
      const src = readFileSync(join(EXAMPLES_DIR, file), 'utf8')
      let scene
      try {
        scene = lower(new Parser(new Lexer(src).tokenize()).parse())
      } catch {
        continue // throw shapes are fixture-sweep.test.ts's concern, not ours
      }
      for (const d of scene.diagnostics ?? []) {
        if (d.code === 'X-GIS0013') offenders.push(`${file}: ${d.message}`)
      }
    }
    expect(offenders, `unknown utilities in corpus:\n${offenders.join('\n')}`).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Unknown utility → X-GIS0013 error + nearest-name help, everywhere
// ─────────────────────────────────────────────────────────────────────────
describe('#1067 unknown utility → X-GIS0013 error (normal lowering)', () => {
  it('`colr-red` is an error with nearest-name help (was a silent no-op)', () => {
    const [d] = diagnosticsFor(
      'source d { type: geojson, url: "x.geojson" }\nlayer l { source: d | colr-red }',
    )
    expect(d).toBeDefined()
    expect(d.severity).toBe('error')
    expect(d.message).toContain('colr-red')
    expect(d.help).toBeDefined()
    expect(d.help).toContain('-') // suggests a known family prefix
  })
  it('`opacty-50` suggests `opacity-`', () => {
    const [d] = diagnosticsFor(
      'source d { type: geojson, url: "x.geojson" }\nlayer l { source: d | opacty-50 }',
    )
    expect(d).toBeDefined()
    expect(d.help).toContain('opacity-')
  })
  it('known valid utilities produce NO X-GIS0013', () => {
    expect(
      diagnosticsFor(
        'source d { type: geojson, url: "x.geojson" }\nlayer l { source: d | fill-red-500 opacity-50 stroke-round-cap hidden size-8 }',
      ),
    ).toEqual([])
  })
})

describe('#1067 unknown / non-animatable utility → X-GIS0013 error (keyframes)', () => {
  // fail-before: lower-animation.ts silently ignored unknown frame utilities.
  it('unknown `opacty-50` inside a frame is an error with nearest-name help', () => {
    const [d] = diagnosticsFor(`
      keyframes k { 0%: opacty-50  100%: opacity-100 }
      source d { type: geojson, url: "x.geojson" }
      layer l { source: d | fill-red-500 | animation-k animation-duration-1000 }
    `)
    expect(d).toBeDefined()
    expect(d.severity).toBe('error')
    expect(d.message).toContain('opacty-50')
    expect(d.message).toContain('keyframes')
    expect(d.help).toContain('opacity-')
  })
  it('unknown `colr-red` inside a frame is an error', () => {
    const [d] = diagnosticsFor(`
      keyframes k { 0%: colr-red  100%: opacity-100 }
      source d { type: geojson, url: "x.geojson" }
      layer l { source: d | fill-red-500 | animation-k animation-duration-1000 }
    `)
    expect(d).toBeDefined()
    expect(d.message).toContain('colr-red')
  })
  it('known-but-NOT-animatable utility in a frame is an error (projection-mercator)', () => {
    const [d] = diagnosticsFor(`
      keyframes k { 0%: projection-mercator  100%: opacity-100 }
      source d { type: geojson, url: "x.geojson" }
      layer l { source: d | fill-red-500 | animation-k animation-duration-1000 }
    `)
    expect(d).toBeDefined()
    expect(d.severity).toBe('error')
    expect(d.message).toContain('not animatable')
  })
  it('a keyframes block of only animatable utilities produces NO X-GIS0013', () => {
    expect(
      diagnosticsFor(`
        keyframes k {
          0%:   opacity-100 fill-blue-500 stroke-amber-300 stroke-2 size-8 stroke-dashoffset-0
          100%: opacity-40  fill-red-500  stroke-sky-400   stroke-8 size-20 stroke-dashoffset-30
        }
        source d { type: geojson, url: "x.geojson" }
        layer l { source: d | fill-blue-500 stroke-amber-300 stroke-2 size-8 stroke-dasharray-16-8 | animation-k animation-duration-2000 }
      `),
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Opacity — uniform 0..100 integers + bracket fractions
// ─────────────────────────────────────────────────────────────────────────
describe('#1067 opacity scale — 0..100 integers, `opacity-[expr]` for fractions', () => {
  function constOpacity(util: string): number {
    const o = layerFor(`fill-red-500 ${util}`).opacity
    if (o.kind !== 'constant') throw new Error(`expected constant opacity, got kind='${o.kind}'`)
    return o.value
  }
  it('opacity-50 = 0.5', () => expect(constOpacity('opacity-50')).toBeCloseTo(0.5, 6))
  it('opacity-100 = 1', () => expect(constOpacity('opacity-100')).toBeCloseTo(1, 6))
  it('opacity-[0.33] = 0.33 (bracket fraction — raw 0..1, NOT /100)', () =>
    expect(constOpacity('opacity-[0.33]')).toBeCloseTo(0.33, 6))
  it('the old opacity-1 == 1.0 cliff is GONE: opacity-1 = 0.01', () =>
    expect(constOpacity('opacity-1')).toBeCloseTo(0.01, 6))

  it('resolveUtilities (the inline-utility runtime path) agrees: opacity-1 = 0.01, not 1.0', () => {
    // The cliff lived ONLY here (utility-resolver.ts) — the lower()/keyframe
    // paths were fixed earlier. Pin the last authority onto the same scale.
    const items = [
      { kind: 'UtilityItem', modifier: null, name: 'opacity-1', binding: null },
    ] as import('../parser/ast').UtilityItem[]
    expect(resolveUtilities(items).opacity).toBeCloseTo(0.01, 6)
  })
})
