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

  it('the current palette holds 20 colours (byte-identical to the pre-#724 cap)', () => {
    // Guards the byte-identical claim: length unchanged means the emitted
    // WGSL (`% 20u`, `array<vec4<f32>, 20>`) is unchanged — no golden rebake.
    expect(CAT_PALETTE_SIZE).toBe(20)
  })
})
