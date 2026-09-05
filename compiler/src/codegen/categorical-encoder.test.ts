// ═══════════════════════════════════════════════════════════════════
// categorical-encoder.ts — single-source palette-size authority (#724)
// ═══════════════════════════════════════════════════════════════════
//
// Regression guard for #724: the auto-categorical palette was capped at a
// magic `20` DUPLICATED between the shader modulo (`% 20`) and the const
// array (`slice(0, 20)`). They could silently drift, wrapping >20-category
// fields onto colliding colours. Both are now derived from CAT_PALETTE_SIZE;
// this locks the const-array side to that single source.

import { describe, expect, it } from 'vitest'
import { buildCatPaletteConst, CAT_PALETTE_SIZE } from './categorical-encoder'

describe('categorical-encoder — CAT_PALETTE single-source size (#724)', () => {
  it('CAT_PALETTE array length === CAT_PALETTE_SIZE (no magic 20 drift)', () => {
    const c = buildCatPaletteConst()
    // Fixed-length WGSL array type carries the size the shader indexes into.
    expect((c.type as { kind: string; size?: number }).size).toBe(CAT_PALETTE_SIZE)
    // The construct expression emits exactly CAT_PALETTE_SIZE vec4 colours.
    // Double-cast through unknown: valueExpr is Expr (a union); only the
    // 'construct' variant carries args, TypeScript won't narrow from union alone.
    expect((c.valueExpr as unknown as { args: readonly unknown[] }).args).toHaveLength(
      CAT_PALETTE_SIZE,
    )
  })

  // #2439 replaced the old `expect(CAT_PALETTE_SIZE).toBe(20)` here. That
  // assertion guarded a byte-identity claim that no longer exists, and it
  // pinned the very cap the issue is about — a test that would have to be
  // edited by anyone fixing the bug is not guarding anything. What follows
  // asserts the PROPERTY the palette actually owes instead, which survives
  // any future N.
  it('every palette entry is a distinct 8-bit colour — the #2439 promise, verified', () => {
    // The promise is "no two categories share a colour", so the palette must
    // not collide with ITSELF first. This mixes 20 hand-picked Tailwind tokens
    // with synthesized golden-angle entries, and nothing structurally forbids
    // a synthesized hue landing on a hand-picked one — so it is measured, at
    // the 8-bit precision a frame actually shows, not argued from the formula.
    const c = buildCatPaletteConst()
    const args = (c.valueExpr as unknown as { args: readonly { args: { value: number }[] }[] }).args
    const seen = new Map<string, number>()
    const collisions: string[] = []
    args.forEach((entry, i) => {
      const key = entry.args
        .slice(0, 3)
        .map((ch) => Math.round(ch.value * 255))
        .join(',')
      const prev = seen.get(key)
      if (prev !== undefined) collisions.push(`entry ${i} == entry ${prev} (rgb ${key})`)
      else seen.set(key, i)
    })
    expect(collisions, collisions.join('; ')).toEqual([])
    expect(seen.size).toBe(CAT_PALETTE_SIZE)
  })

  it('the palette is large enough for the corpus it was sized for (#2439)', () => {
    // countries.geojson — the fixture behind `categorical.xgis`,
    // `vector-categorical.xgis` and #724's original survey — carries 258
    // distinct `name` values. A palette below that cannot be collision-free on
    // the flagship demo no matter how good the index is, so the floor is
    // asserted rather than left to the constant's docstring.
    expect(CAT_PALETTE_SIZE).toBeGreaterThanOrEqual(258)
  })

  it('buildCatPaletteConst supplies as many initializers as it declares, at any N', () => {
    // fail-before: `array<vec4f, N>` was built from `palette.slice(0, N)` over
    // a 20-entry source, so any N past 20 declared a length it did not fill —
    // a WGSL type error, unreachable only because both call sites passed no
    // argument (#2439 step 2 §7). The parameter reads like data-sized-palette
    // support; this makes it be that.
    // `CAT_PALETTE_SIZE + 88` is the arm that DISTINGUISHES the fix. Below the
    // palette's own length a plain `slice(0, n)` already returns n entries, so
    // every smaller arm here passes with the bug present — they pin the
    // contract, they do not detect its violation. Only asking for MORE than
    // the backing array holds separates "slice" from "synthesize on demand".
    for (const n of [1, 20, 21, 64, 300, CAT_PALETTE_SIZE, CAT_PALETTE_SIZE + 88]) {
      const c = buildCatPaletteConst(n)
      expect((c.type as { size?: number }).size, `declared size at N=${n}`).toBe(n)
      expect(
        (c.valueExpr as unknown as { args: readonly unknown[] }).args,
        `initializer count at N=${n}`,
      ).toHaveLength(n)
    }
  })
})
