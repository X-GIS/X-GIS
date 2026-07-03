// iter-325 — CPU-side REPRODUCTION of the user-reported OFM Bright
// Seoul bilingual label corruption (#8.60/37.35270/126.59795):
//   text-field = "Seoul\n서울특별시"
//   expected:  Seoul        actual (ghost behind):    울특별시
//              서울특별시                              서
//   i.e. line-2 glyphs land on / above line-1, split + mis-stacked.
//
// Drives the REAL line-break (wrapWithKnuthPlass via wrapForTesting),
// the REAL vertical model (mlVerticalLayout), and the REAL glyph
// shaper (GlyphAtlasHost.ensureString + MockRasterizer) — no GPU.
// Replicates ONLY the prepare() composition loop (text-stage.ts
// 1563-1577) since it is inline. Whichever assertion fails localizes
// the bug to a CPU stage BEFORE the render pipeline.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlyphAtlasHost } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { wrapForTesting, mlVerticalLayout } from '@xgis/map'
import { greedyPlaceBboxes, type CollisionItem } from '@xgis/map'

const TEXT = 'Seoul\n서울특별시'
const CODE = [...TEXT].map((c) => c.codePointAt(0)!) // 11 incl \n=10

function shape() {
  const host = new GlyphAtlasHost({ slotSize: 32, pageSize: 256 }, new MockRasterizer(), {
    fontSize: 16,
    sdfRadius: 6,
  })
  const glyphs = host.ensureString('noto', TEXT)
  return {
    glyphs,
    codepoints: glyphs.map((g) => g.codepoint),
    advances: glyphs.map((g) => g.advanceWidth),
  }
}

describe('iter-325 Seoul bilingual label — CPU placement repro', () => {
  it('A: ensureString preserves the hard newline (cp 10) — wrap depends on it', () => {
    // wrapWithKnuthPlass splits segments on glyphs[i].codepoint===10.
    // If ensureString strips \n, wrap sees "Seoul서울특별시" as ONE run
    // → CJK-break corruption.
    const { codepoints, glyphs } = shape()
    expect(codepoints).toContain(10)
    expect(glyphs.length).toBe(CODE.length) // 11
    expect(codepoints).toEqual(CODE)
  })

  it('B: wrap splits on \\n into exactly 2 lines — Seoul[0,5) / 서울특별시[6,11)', () => {
    const { codepoints, advances } = shape()
    const lines = wrapForTesting(codepoints, advances, Infinity)
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ start: 0, end: 5 }) // Seoul
    expect(lines[1]).toMatchObject({ start: 6, end: 11 }) // 서울특별시
  })

  it('C: composition positions every NON-newline glyph exactly once', () => {
    // The composition loop only writes glyphOffsets for glyph indices
    // inside a line range. Indices in NO range keep their stale/zero
    // FrameArena slot. Assert: every visible glyph is covered once; the
    // \n glyph (index 5) is the only uncovered one.
    const { codepoints, advances } = shape()
    const lines = wrapForTesting(codepoints, advances, Infinity)
    const covered = new Set<number>()
    for (const ln of lines) {
      for (let gi = ln.start; gi < ln.end; gi++) {
        expect(covered.has(gi), `glyph ${gi} double-positioned`).toBe(false)
        covered.add(gi)
      }
    }
    for (let gi = 0; gi < codepoints.length; gi++) {
      if (codepoints[gi] === 10) {
        // The newline glyph is intentionally unpositioned — the render
        // loop MUST skip it (verified in the renderer-draw test below).
        expect(covered.has(gi), 'newline glyph unexpectedly positioned').toBe(false)
        continue
      }
      expect(covered.has(gi), `visible glyph ${gi} (cp ${codepoints[gi]}) UNPOSITIONED`).toBe(true)
    }
  })

  it('D: line-2 (서울특별시) renders BELOW line-1 (Seoul) — no vertical inversion', () => {
    const { codepoints, advances } = shape()
    const lines = wrapForTesting(codepoints, advances, Infinity)
    const vlay = mlVerticalLayout(0.5, lines.length, 16 * 1.2, 16)
    // Replicate the composition: each glyph's y = its line's baseline.
    const glyphY: number[] = new Array(codepoints.length).fill(NaN)
    for (let li = 0; li < lines.length; li++) {
      for (let gi = lines[li]!.start; gi < lines[li]!.end; gi++) {
        glyphY[gi] = vlay.baselineY[li]!
      }
    }
    // Latin glyphs 0..4 (Seoul) vs CJK glyphs 6..10 (서울특별시).
    for (let cjk = 6; cjk <= 10; cjk++) {
      for (let lat = 0; lat <= 4; lat++) {
        expect(
          glyphY[cjk]! > glyphY[lat]!,
          `CJK glyph ${cjk} (y=${glyphY[cjk]}) not below Latin ${lat} (y=${glyphY[lat]})`,
        ).toBe(true)
      }
    }
  })

  it('FIX: every glyph the renderer DRAWS is positioned — \\n is skipped, not stale-stamped', () => {
    // BUG was: text-renderer.ts:374 looped ALL d.glyphs (= ensureString
    // output, INCLUDING the \n glyph) and read glyphOffsets[gi*2..] to
    // place each quad. The composition loop (text-stage.ts:1563-1577)
    // only writes offsets for glyphs inside a wrap line range — the \n
    // (cp 10) is in NO range, so its slot was UNWRITTEN → the renderer
    // stamped a quad at stale FrameArena data (a previous label's
    // position) = ghost glyph.
    //
    // FIX: the draw loop skips codepoint===10. Contract now holds:
    // the DRAWN set (non-newline glyphs) ⊆ the positioned set, and the
    // \n is neither drawn nor positioned.
    const { codepoints, advances } = shape()
    const lines = wrapForTesting(codepoints, advances, Infinity)
    const positioned = new Set<number>()
    for (const ln of lines) for (let gi = ln.start; gi < ln.end; gi++) positioned.add(gi)

    for (let gi = 0; gi < codepoints.length; gi++) {
      const isNewline = codepoints[gi] === 10
      if (isNewline) {
        // Skipped by the renderer → must NOT be drawn (and isn't positioned).
        expect(positioned.has(gi), 'newline unexpectedly positioned').toBe(false)
      } else {
        // Drawn → must be positioned (no stale-offset stamp).
        expect(positioned.has(gi), `drawn glyph ${gi} (cp ${codepoints[gi]}) UNPOSITIONED`).toBe(
          true,
        )
      }
    }
  })

  it('FIX-SOURCE: text-renderer draw loop guards codepoint===10', () => {
    // Pin the actual fix in renderer source (the model test above asserts
    // the contract; this asserts the code that enforces it exists).
    // text-renderer.ts relocated to @xgis/map (P3 Batch B7); `here` is
    // runtime/src/engine/text → up 4 to repo root, then into map/src/text.
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(
      join(here, '..', '..', '..', '..', 'map', 'src', 'text', 'text-renderer.ts'),
      'utf8',
    )
    // The skip must appear inside the per-glyph draw loop.
    expect(src).toMatch(/if\s*\(\s*g\.codepoint\s*===\s*10\s*\)\s*continue/)
  })

  it('E: intra-line x is strictly increasing (no horizontal glyph overlap)', () => {
    const { codepoints, advances } = shape()
    const lines = wrapForTesting(codepoints, advances, Infinity)
    for (let li = 0; li < lines.length; li++) {
      let pen = 0
      let prevPen = -Infinity
      for (let gi = lines[li]!.start; gi < lines[li]!.end; gi++) {
        expect(pen > prevPen, `line ${li} glyph ${gi} pen not advancing`).toBe(true)
        prevPen = pen
        pen += advances[gi]!
      }
    }
  })
})

// iter-325 CROSS-CHECK — the "울특별시 ghost behind Seoul" symptom needs
// TWO overlapping labels for the same point. The collision pass
// (greedyPlaceBboxes, called globally over ALL labels in
// text-stage.ts:1894-1920) MUST drop one when their bboxes overlap —
// otherwise both render = the ghost. This pins that the cross-layer
// dedup path (iter-278/280) stays closed, so the ghost cannot come
// from a collision gap. Together with the \n-skip fix above, the two
// candidate mechanisms for the symptom are both gated.
describe('iter-325 cross-check — overlapping duplicate Seoul labels dedup', () => {
  // Two labels at the SAME anchor (e.g. place_city "Seoul\n서울" +
  // another layer "서울특별시"), bboxes overlapping. Exactly one survives.
  const overlapBbox = { minX: -40, minY: -20, maxX: 40, maxY: 20 }

  it('two overlapping same-anchor labels → exactly ONE placed (no ghost)', () => {
    const items: CollisionItem[] = [
      { bboxes: [{ ...overlapBbox }] }, // label A "Seoul\n서울"
      { bboxes: [{ minX: -38, minY: -18, maxX: 42, maxY: 22 }] }, // label B "서울특별시" (overlaps A)
    ]
    const placed = greedyPlaceBboxes(items)
    const placedCount = placed.filter((p) => p.placed).length
    expect(placedCount, 'overlapping duplicate labels must dedup to one').toBe(1)
  })

  it('allowOverlap label DOES co-place (documents the only legit overlap path)', () => {
    // The one way both render: allowOverlap (Mapbox text-allow-overlap).
    // If the user-reported ghost has this set in the style, the overlap
    // is BY DESIGN, not a bug — this documents that branch.
    const items: CollisionItem[] = [
      { bboxes: [{ ...overlapBbox }] },
      { bboxes: [{ ...overlapBbox }], allowOverlap: true },
    ]
    const placed = greedyPlaceBboxes(items)
    expect(placed.filter((p) => p.placed).length).toBe(2)
  })

  it('non-overlapping same-feature labels both place (different anchors)', () => {
    const items: CollisionItem[] = [
      { bboxes: [{ minX: -40, minY: -20, maxX: 40, maxY: 20 }] },
      { bboxes: [{ minX: 100, minY: 100, maxX: 180, maxY: 140 }] }, // far away
    ]
    const placed = greedyPlaceBboxes(items)
    expect(placed.filter((p) => p.placed).length).toBe(2)
  })
})
