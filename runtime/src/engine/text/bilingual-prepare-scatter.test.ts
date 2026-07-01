// iter-327 — PRECISE repro of the user-reported intermittent ("일부만")
// bilingual label SCATTER: "서울특별시" glyphs land on the wrong lines /
// x positions (서 low-left, 울특별 up over Seoul, 시 low-right). This is
// NOT the iter-325 \n stray glyph (1 glyph) — it's the WHOLE line-2
// glyphOffsets going wrong, and only for SOME labels.
//
// Drives the REAL TextStage.prepare() (wrap + mlVerticalLayout +
// composition loop + layout cache) with a stub GPU device (prepare is
// CPU-only; the GPU is only touched at setDraws/draw, which we spy
// past). Inspects the actual glyphOffsets in the produced TextDraws.
//
// Prime suspect: the layout-cache hit check (text-stage.ts:1437) only
// validates `generation`, NOT that the cached entry is for the same
// text — a 32-bit `_layoutKey` hash collision would serve label B
// label A's cached glyphs+glyphOffsets. "일부만" = colliding labels.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

// WebGPU bitflag globals the GPU classes reference at construction —
// not present in the node test env. Values per the WebGPU spec.
const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

// Recursive Proxy stub — any property access returns a callable that
// returns the same stub; numeric-ish props return a number so the GPU
// classes' constructors don't choke on `.size` / `.width`.
function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(function () { return stub }, {
    get(_t, p) {
      if (p === 'size') return 1 << 22
      if (p === 'width' || p === 'height') return 4096
      if (p === 'limits') return { maxTextureDimension2D: 8192 }
      if (p === Symbol.toPrimitive) return () => 0
      return stub
    },
    apply() { return stub },
  })
  return stub as GPUDevice
}

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}

function defOf(size: number, maxWidth: number, anchor: string = 'bottom'): LabelDef {
  return {
    text: litValue(''),
    size,
    maxWidth,
    font: ['Noto Sans Bold'],
    anchor,
  } as LabelDef
}

/** Build a stage, spy on its renderer.setDraws to capture draws.
 *  `small` forces a tiny atlas to provoke overflow + eviction. */
function makeStage(small = false) {
  const opts = small
    ? { rasterizer: new MockRasterizer(), slotSize: 32, pageSize: 128 }  // 16 slots
    : { rasterizer: new MockRasterizer() }
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', opts)
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

/** For one draw, group glyphOffsets Y by approximate line + assert each
 *  line's glyphs are horizontally monotonic and share one baseline. */
function assertNoScatter(draw: TextDraw, ctx: string): void {
  const off = draw.glyphOffsets
  expect(off, `${ctx} no glyphOffsets`).toBeDefined()
  const glyphs = draw.glyphs
  // Collect (y) per non-newline glyph; bucket by rounded y = line.
  const lineYs = new Set<number>()
  let prevY = NaN
  let prevX = -Infinity
  for (let gi = 0; gi < glyphs.length; gi++) {
    if (glyphs[gi]!.codepoint === 10) continue  // \n: not positioned (iter-325)
    const x = off![gi * 2]!
    const y = off![gi * 2 + 1]!
    expect(Number.isFinite(x) && Number.isFinite(y), `${ctx} g${gi} non-finite (${x},${y})`).toBe(true)
    const yKey = Math.round(y * 100) / 100
    if (yKey !== Math.round(prevY * 100) / 100) {
      // New line: x resets (allowed to go back). Record the line.
      lineYs.add(yKey)
      prevX = -Infinity
    }
    // Within a line, x must strictly increase (no overlap / scatter).
    expect(x > prevX, `${ctx} g${gi} x not increasing within line (x=${x} prev=${prevX} y=${y})`).toBe(true)
    prevX = x
    prevY = y
  }
}

/** Find the draw whose glyph codepoints contain the given CJK char. */
function findDrawWithText(draws: TextDraw[], cp: number): TextDraw | undefined {
  return draws.find(d => d.glyphs.some(g => g.codepoint === cp))
}

const SEOUL = 'Seoul\n서울특별시'   // label_city_capital text-field result

describe('iter-327 bilingual prepare() scatter — real TextStage, stub GPU', () => {
  it('single Seoul label: line-2 glyphs share baseline, x monotonic (no scatter)', () => {
    const { stage, captured } = makeStage()
    stage.setCameraZoom(8.6)
    stage.beginFrame()
    stage.addLabel(litValue(SEOUL), {}, 400, 300, defOf(15, 8))
    stage.prepare()
    expect(captured.length).toBe(1)
    const draws = captured[0]!
    const seoul = findDrawWithText(draws, 0xc11c)  // 서
    expect(seoul, 'Seoul draw missing').toBeDefined()
    assertNoScatter(seoul!, 'single-seoul')
  })

  it('many labels + repeated frames (cache hit path): no label scatters', () => {
    // Populate with a realistic dense bilingual scene across MULTIPLE
    // frames so the layout cache is exercised (frame 1 miss → cache,
    // frame 2+ hit → returns cached glyphs+glyphOffsets). If a hash
    // collision serves the wrong layout, some label scatters.
    const cities: [string, number][] = [
      ['Seoul\n서울특별시', 0xc11c],   // 서
      ['Busan\n부산광역시', 0xbd80],   // 부
      ['Incheon\n인천광역시', 0xc778], // 인
      ['Daegu\n대구광역시', 0xb300],   // 대
      ['Tokyo\n東京都', 0x6771],       // 東
      ['Osaka\n大阪市', 0x5927],       // 大
      ['Beijing\n北京市', 0x5317],     // 北
      ['Pyongyang\n평양시', 0xd3c9],   // 평
    ]
    const { stage, captured } = makeStage()
    stage.setCameraZoom(10)
    for (let frame = 0; frame < 3; frame++) {
      stage.beginFrame()
      cities.forEach(([txt], i) => {
        // spread anchors so collision doesn't drop them
        stage.addLabel(litValue(txt), {}, 100 + i * 90, 100 + (i % 3) * 120, defOf(14, 8))
      })
      stage.prepare()
      stage.reset()
    }
    // Inspect the LAST frame (cache fully warm → all hits).
    const lastDraws = captured[captured.length - 1]!
    for (const [, cp] of cities) {
      const d = findDrawWithText(lastDraws, cp)
      if (d) assertNoScatter(d, `cp-${cp.toString(16)}`)
    }
  })

  it('TINY atlas overflow + eviction: surviving labels do not scatter', () => {
    // 16-slot atlas, many unique CJK glyphs → forces preload eviction +
    // generation bumps (iter-273 class). Any label hasAllGlyphs drops →
    // text='' (empty draw). Any SURVIVING label must still be coherent.
    // If overflow corrupts glyphOffsets for a survivor → scatter here.
    const cities: [string, number][] = [
      ['Seoul\n서울특별시', 0xc11c],
      ['Busan\n부산광역시', 0xbd80],
      ['Daejeon\n대전광역시', 0xb300],
      ['Gwangju\n광주광역시', 0xad11],
      ['Ulsan\n울산광역시', 0xc6b8],
      ['Sejong\n세종특별자치시', 0xc138],
    ]
    const { stage, captured } = makeStage(true)
    stage.setCameraZoom(11)
    for (let frame = 0; frame < 4; frame++) {
      stage.beginFrame()
      cities.forEach(([txt], i) => {
        stage.addLabel(litValue(txt), {}, 100 + i * 70, 100 + (i % 2) * 150, defOf(14, 8))
      })
      stage.prepare()
      stage.reset()
    }
    const lastDraws = captured[captured.length - 1]!
    // Every emitted draw (non-empty) must be coherent — no scatter.
    for (const d of lastDraws) {
      if (d.glyphs.length === 0) continue
      assertNoScatter(d, `overflow-draw-${d.glyphs.map(g => g.codepoint).join(',')}`)
    }
  })

  // iter-328 — user repro: OFM Bright z=6 country label
  // "South Korea\n대한민국" with anchor=CENTER (label_country default,
  // vs city's bottom) + max-width 6.25. Newline splits but line-2
  // (대한민국) renders OVERLAPPING line-1 instead of below.
  it('country label (center anchor): line-2 (대한민국) renders BELOW line-1, not overlapping', () => {
    const { stage, captured } = makeStage()
    stage.setCameraZoom(6)
    stage.beginFrame()
    // label_country_3 @ z6: size≈15, max-width 6.25, Bold, anchor center (undefined → center).
    stage.addLabel(litValue('South Korea\n대한민국'), {}, 400, 300, defOf(15, 6.25, 'center'))
    stage.prepare()
    const draws = captured[0]!
    const draw = findDrawWithText(draws, 0xb300)  // 대
    expect(draw, 'country draw missing').toBeDefined()
    // Collect y per non-newline glyph; CJK (대한민국, 0xAC00-0xD7A3) must
    // all sit BELOW the Latin glyphs (South Korea).
    const latinYs: number[] = []
    const cjkYs: number[] = []
    const g = draw!.glyphs
    const off = draw!.glyphOffsets!
    for (let i = 0; i < g.length; i++) {
      const cp = g[i]!.codepoint
      if (cp === 10) continue
      const y = off[i * 2 + 1]!
      if (cp >= 0xac00 && cp <= 0xd7a3) cjkYs.push(y)
      else if (cp !== 32) latinYs.push(y)
    }
    expect(cjkYs.length).toBeGreaterThan(0)
    expect(latinYs.length).toBeGreaterThan(0)
    const maxLatinY = Math.max(...latinYs)
    const minCjkY = Math.min(...cjkYs)
    // Every CJK glyph's baseline must be strictly below every Latin one
    // (screen-down +y). Overlap = minCjkY <= maxLatinY → the bug.
    expect(minCjkY > maxLatinY,
      `대한민국 overlaps South Korea: minCjkY=${minCjkY} maxLatinY=${maxLatinY}`).toBe(true)
  })
})
