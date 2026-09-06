// #2544 — `captureFnCallAsString` rebuilt a style-property function call from
// TOKENS with a HEURISTIC separator ("insert a space unless the previous char
// is `(` or `-`, or this token is a comma"). `%`, a unit suffix (`deg`) and a
// bare `.` are each their own token, so the rebuild glued a space where CSS
// allows none:
//
//   written                  captured (pre-fix)         resolveColor
//   hsl(120, 50%, 50%)   →   hsl(120, 50 %, 50 %)   →   null
//   rgba(0, 0, 0, .6)    →   rgba(0, 0, 0, . 6)     →   null
//   hsl(120deg 50% 50%)  →   hsl(120 deg 50 % 50 %) →   null
//
// `lower.ts` then does `if (hex) fill = …`, so a null skipped the assignment
// and the layer rendered with NO fill and NO diagnostic.
//
// The fix removes the heuristic: the LEXER — the only component holding the
// source — records `spaceBefore` per token, and the re-serializer replays it.
// So this suite asserts the captured string is BYTE-EQUAL to what was written,
// not merely that it happens to resolve. The `rgb(...)` / `oklab(...)` rows are
// CONTROLS: they round-trip under the old heuristic too, so a suite that stayed
// green on them alone would be measuring nothing.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { resolveColor } from '../tokens/colors'
import { withPragma } from './_pragma'

const srcWithFill = (value: string) => `
  source s { type: geojson, url: "x.geojson" }
  layer l {
    source: s
    fill: ${value}
  }
`

/** The captured `fill:` StyleProperty value — the re-serializer's output. */
function captureFillValue(value: string): string {
  const ast = new Parser(new Lexer(withPragma(srcWithFill(value))).tokenize()).parse()
  let found: string | undefined
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const node = n as Record<string, unknown>
    if (node.kind === 'StyleProperty' && node.name === 'fill') {
      found = node.value as string
      return
    }
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') visit(v)
    }
  }
  visit(ast)
  if (found === undefined) throw new Error('fill StyleProperty not found')
  return found
}

function sceneOf(value: string) {
  return lower(new Parser(new Lexer(withPragma(srcWithFill(value))).tokenize()).parse())
}

describe('#2544 — the fn-call re-serializer reproduces what was written', () => {
  // The three shapes the heuristic broke.
  it.each([
    ['percent channels, comma form', 'hsl(120, 50%, 50%)'],
    ['leading-dot alpha', 'rgba(0, 0, 0, .6)'],
    ['unit suffix + percent, space form', 'hsl(120deg 50% 50%)'],
    ['percent channels on rgb()', 'rgb(100%, 0%, 0%)'],
    ['percent channels, space form', 'hsl(120 50% 50%)'],
    // Controls — these round-tripped BEFORE the fix as well. They pin that the
    // fix did not trade one broken spelling for another.
    ['comma form (control)', 'rgb(255, 0, 0)'],
    ['negative channels, space form (control)', 'oklab(0.5 -0.05 0.1)'],
    ['slash alpha (control)', 'rgb(255 0 0 / 0.5)'],
  ])('%s: `%s` round-trips byte-identically', (_label, written) => {
    expect(captureFillValue(written)).toBe(written)
  })

  it.each([
    ['hsl(120, 50%, 50%)', '#40bf40'],
    ['rgba(0, 0, 0, .6)', '#00000099'],
    ['hsl(120deg 50% 50%)', '#40bf40'],
    ['rgb(100%, 0%, 0%)', '#ff0000'],
    ['rgb(255, 0, 0)', '#ff0000'],
  ])('`%s` resolves to %s after capture (same as the written string)', (written, hex) => {
    // Instrument check: the compiler's own resolver accepts the WRITTEN form.
    expect(resolveColor(written)).toBe(hex)
    expect(resolveColor(captureFillValue(written))).toBe(hex)
  })

  it('`fill: hsl(120, 50%, 50%)` lowers to the same constant as `fill: #40bf40`', () => {
    const viaHsl = sceneOf('hsl(120, 50%, 50%)').renderNodes[0]!.fill
    const viaHex = sceneOf('#40bf40').renderNodes[0]!.fill
    expect(viaHsl.kind).toBe('constant')
    expect(viaHsl).toEqual(viaHex)
  })
})

describe('#2544 — an unresolvable fill:/stroke: value is reported, not dropped', () => {
  it('warns X-GIS0029 on a `fill:` value no resolver accepts', () => {
    const scene = sceneOf('rgb(nope, nope, nope)')
    const d = scene.diagnostics!.find((d) => d.code === 'X-GIS0029')
    expect(d).toBeDefined()
    expect(d!.severity).toBe('warn')
    expect(d!.message).toContain('fill')
    expect(d!.message).toContain('rgb(nope, nope, nope)')
  })

  it('warns on an unresolvable `stroke:` value too', () => {
    const scene = lower(
      new Parser(
        new Lexer(
          withPragma(`
            source s { type: geojson, url: "x.geojson" }
            layer l {
              source: s
              stroke: rgb(nope, nope, nope)
            }
          `),
        ).tokenize(),
      ).parse(),
    )
    const d = scene.diagnostics!.find((d) => d.code === 'X-GIS0029')
    expect(d).toBeDefined()
    expect(d!.message).toContain('stroke')
  })

  it('a RESOLVABLE fill: produces no X-GIS0029 (the warning is not blanket)', () => {
    for (const v of ['hsl(120, 50%, 50%)', '#40bf40', 'rgb(255, 0, 0)']) {
      const scene = sceneOf(v)
      expect(scene.diagnostics?.filter((d) => d.code === 'X-GIS0029') ?? []).toEqual([])
    }
  })
})
