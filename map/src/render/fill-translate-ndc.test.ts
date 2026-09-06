// fill-translate: ONE producer, and every packer must route through it (#2240).
//
// Slots 46/47 (`fill_translate_x/y`) are read by two vertex shaders — the
// polygon VS offsets the fill, and the LINE VS offsets a fill's OUTLINE by the
// same amount so the two stay glued together (shaders/dsl/line.ts:1449-1462).
// Three sites in vector-tile-renderer.ts pack those slots, and before #2240 each
// derived the value on its own: render() computed it, while the WebGL2 twins
// (renderFillsRhi / renderLinesRhi) wrote an unconditional 0. An authored
// `fill-translate` therefore moved the fill on WebGPU and was silently dropped
// on WebGL2 — measured on `fixture_fill_translate` as a 60-px-wide cross-backend
// diff band matching the authored `fill-translate-x-60` exactly (6.98% of the
// frame before, 0.00% after).
//
// So the invariant this file gates is not "the three sites currently agree" —
// three sites agreeing is what already failed. It is that ALL of them read one
// producer, `fillTranslateNdc`, so a fourth packer inherits the value by
// construction (CLAUDE.md §12, the #2165 shape: a witness applied at a packer
// dies the day the packer is replaced).
//
// Two halves, because neither alone is sufficient:
//   1. the producer's own behaviour (executable, below);
//   2. a SOURCE gate over the packers. `renderFillsRhi` / `renderLinesRhi` need
//      a real device, source, layer cache and camera to reach their pack, and a
//      stub deep enough to execute one would pin the mock rather than the code
//      (the reason spec-wiring/fill-antialias-wiring.test.ts states for its own
//      #1999 source block). Each arm is asserted separately so restoring THAT
//      arm's constant reds with a message naming it.

import { describe, it, expect } from 'vitest'
import { fillTranslateNdc } from './fill-translate-ndc'
import type { ResolvedShow } from './resolved-show'
import type { ShowCommand } from './renderer-types'
import type { Camera } from '../camera'
import { renderPathSource } from './render-path-source'

const W = 1000
const H = 500

function call(
  dx: number,
  dy: number,
  anchorMap: boolean | undefined = undefined,
  bearing = 0,
): readonly [number, number] {
  return fillTranslateNdc(
    { fillTranslateX: dx, fillTranslateY: dy } as ResolvedShow,
    { fillTranslateAnchorMap: anchorMap } as ShowCommand,
    { bearing } as Camera,
    W,
    H,
  )
}

describe('fillTranslateNdc — CSS px → NDC-per-pixel (#2240)', () => {
  it('scales each axis by 2 / its own canvas dimension', () => {
    // Not 2/W on both: the y axis is 500 px tall here, so the same authored
    // offset is twice the NDC step it is on x. A shared divisor would pass a
    // square-canvas test and skew every non-square frame.
    expect(call(60, 60)).toEqual([(60 * 2) / W, (60 * 2) / H])
  })

  it('an unauthored offset packs +0 on both axes', () => {
    // Object.is, not toBe(0): -0 would compare equal to 0 while changing the
    // packed bytes of every untranslated show in the atlas.
    const [x, y] = call(0, 0)
    expect(Object.is(x, 0)).toBe(true)
    expect(Object.is(y, 0)).toBe(true)
  })

  it('a NEGATIVE offset keeps its sign (not clamped by the zero guard)', () => {
    expect(call(-60, -20)).toEqual([(-60 * 2) / W, (-20 * 2) / H])
  })

  it('translate-anchor: viewport (the default) ignores the bearing', () => {
    expect(call(60, 0, undefined, 90)).toEqual(call(60, 0, undefined, 0))
    expect(call(60, 0, false, 90)).toEqual(call(60, 0, false, 0))
  })

  it('translate-anchor: map rotates the offset by the camera bearing', () => {
    // 60 px on +x at bearing 90° becomes 60 px on +y — and the y result must
    // then be divided by H, not W, or the rotation silently changes length.
    const [x, y] = call(60, 0, true, 90)
    expect(x).toBeCloseTo(0, 12)
    expect(y).toBeCloseTo((60 * 2) / H, 12)
  })
})

// ─── The SOURCE gate: every packer reads the producer ────────────────────────

// #2537 — the packers this gate pins now live across the class AND its phase
// modules; `renderPathSource()` is that whole path, the scope this assertion was
// written against.
const VTR_SRC = renderPathSource()

/** Body of `name`, from its signature up to `until`'s. */
function body(name: string, until: string): string {
  const at = VTR_SRC.indexOf(`\n  ${name}(`)
  expect(at, `${name} still exists in vector-tile-renderer.ts`).toBeGreaterThan(-1)
  const end = VTR_SRC.indexOf(`\n  ${until}(`, at)
  expect(end, `${until} still follows ${name} (update this gate if it moved)`).toBeGreaterThan(at)
  return VTR_SRC.slice(at, end)
}

/** Every `fill_translate_x(<arg>)` argument in the renderer, in source order. */
function packedXArgs(): string[] {
  return [...VTR_SRC.matchAll(/fill_translate_x\(([^)]*)\)/g)].map((m) => m[1]!.trim())
}

describe('every fill_translate packer routes through fillTranslateNdc (#2240)', () => {
  it('the WebGPU arm (render) derives from the producer and packs what it derived', () => {
    const iDerive = VTR_SRC.indexOf('const fillTr = fillTranslateNdc(resolvedShow, show, camera')
    const iField = VTR_SRC.indexOf('this.currentFillTranslateNdcX = fillTr[0]')
    const iPack = VTR_SRC.indexOf('fill_translate_x(this.currentFillTranslateNdcX)')
    expect(iDerive, 'render() must derive fillTr from fillTranslateNdc').toBeGreaterThan(-1)
    expect(iField, 'render() must bake fillTr[0] into currentFillTranslateNdcX').toBeGreaterThan(-1)
    expect(iPack, 'the frame block must pack currentFillTranslateNdcX').toBeGreaterThan(-1)
    expect(iDerive, 'render() must derive before it bakes').toBeLessThan(iField)
  })

  it('the WebGL2 FILLS arm derives from the producer and packs what it derived', () => {
    // Fail-before: restore `B.set.fill_translate_x(0)` in renderFillsRhi and
    // this reds naming the fills arm — an authored fill-translate would be
    // dropped on WebGL2 again while WebGPU still honoured it.
    const fills = body('renderFillsRhi', 'renderLinesRhi')
    const iDerive = fills.indexOf('fillTranslateNdc(')
    const iPack = fills.indexOf('fill_translate_x(fillTr[0])')
    expect(iDerive, 'renderFillsRhi must call fillTranslateNdc').toBeGreaterThan(-1)
    expect(
      iPack,
      'renderFillsRhi must pack fillTr[0] into fill_translate_x, not a constant',
    ).toBeGreaterThan(-1)
    expect(iDerive, 'renderFillsRhi must derive before it packs').toBeLessThan(iPack)
  })

  it('the WebGL2 LINES arm derives from the producer and packs what it derived', () => {
    // Fail-before: restore `B.set.fill_translate_x(0)` in renderLinesRhi and
    // this reds naming the lines arm. Cutting it alone leaves the fills arm
    // green — which is the point: a polygon's outline draws through the LINE
    // pipeline reading the FILL's slots, so a translated fill would slide out
    // from under its own stroke.
    const lines = body('renderLinesRhi', 'ensureLabelTilesRhi')
    const iDerive = lines.indexOf('fillTranslateNdc(')
    const iPack = lines.indexOf('fill_translate_x(lineFillTr[0])')
    expect(iDerive, 'renderLinesRhi must call fillTranslateNdc').toBeGreaterThan(-1)
    expect(
      iPack,
      'renderLinesRhi must pack lineFillTr[0] into fill_translate_x, not a constant',
    ).toBeGreaterThan(-1)
    expect(iDerive, 'renderLinesRhi must derive before it packs').toBeLessThan(iPack)
  })

  it('NO packer writes a fill-translate the producer did not make', () => {
    // The exhaustive half, and the only one a FOURTH packer cannot slip past.
    // Anything not on this list is either a new arm that must call
    // fillTranslateNdc, or a new documented exception that belongs here.
    const ALLOWED = new Set([
      // The three producer-derived packs asserted individually above.
      'fillTr[0]',
      'lineFillTr[0]',
      'this.currentFillTranslateNdcX',
      // #1154 — a PATTERN fill overloads the same slots with the world repeat
      // in Mercator metres and sets pattern_active=1; the VS then gates the
      // NDC offset off entirely. Not a fill-translate value.
      'pack.repeatMX',
      'this._patternRepeatMX',
      // bakeTileToTexture — an offscreen bake with no camera and no show-level
      // translate; the literal is the absence of an offset, not a dropped one.
      '0',
    ])
    const unknown = packedXArgs().filter((a) => !ALLOWED.has(a))
    expect(
      unknown,
      `fill_translate_x is packed from ${JSON.stringify(unknown)}, which no rule here explains — a new packer must read fillTranslateNdc (#2240), or add it above with why it is exempt`,
    ).toEqual([])
  })

  it('the y axis is packed from the same producer tuple as x', () => {
    // x and y come out of one call; packing y from anywhere else would put a
    // stale or mismatched axis into the pair.
    const ys = [...VTR_SRC.matchAll(/fill_translate_y\(([^)]*)\)/g)].map((m) => m[1]!.trim())
    expect(ys).toEqual([
      '0', // bakeTileToTexture
      'pack.repeatMY', // renderFillsRhi, pattern
      'fillTr[1]', // renderFillsRhi
      'lineFillTr[1]', // renderLinesRhi
      'this._patternRepeatMY', // render(), pattern
      'this.currentFillTranslateNdcY', // render()
    ])
  })
})
