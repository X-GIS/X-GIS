// ═══ #2042 INC-4c — split-mode line emit: structure + transform
//     completeness gate ═══
//
// buildLineSplitModule derives the three-block stroke shader from the
// legacy line module (line-split.ts) with the SAME rewriter authority as
// polygon-split. Mirrors polygon-split-emit.test.ts's pins:
//   1. FrameBlock(11)/ShowBlock(10)/TileBlock(7) declared, legacy
//      TileUniforms(0) gone;
//   2. NO `u.` read survives;
//   3. partition routing + retired-lane recombinations land;
//   4. auto-var identity preserved (the INC-4b vanished-fills class);
//   5. the legacy emit is untouched by the transform existing.

import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from './line'
import { emitLineSplitWgsl } from './line-split'

const NULL_SPLIT = emitLineSplitWgsl(null, false)
const NULL_SPLIT_PICK = emitLineSplitWgsl(null, true)

describe('#2042 INC-4c — split-mode line emit', () => {
  it('declares the three blocks at their reserved bindings, and no legacy block', () => {
    for (const w of [NULL_SPLIT, NULL_SPLIT_PICK]) {
      expect(w).toContain('@group(0) @binding(11) var<uniform> frame: FrameBlock;')
      expect(w).toContain('@group(0) @binding(10) var<uniform> show: ShowBlock;')
      expect(w).toContain('@group(0) @binding(7) var<uniform> tile: TileBlock;')
      expect(w).not.toContain('struct TileUniforms')
      expect(w).not.toMatch(/@group\(0\) @binding\(0\)\s+var<uniform>/)
      // the LAYER group + storage bindings survive untouched
      expect(w).toContain('@group(1) @binding(0) var<uniform> layer: LineLayer;')
    }
  })

  it('NO legacy `u.` read survives the transform', () => {
    for (const w of [NULL_SPLIT, NULL_SPLIT_PICK]) {
      expect(w).not.toMatch(/\bu\./)
      expect(w).not.toContain('cam_ecef_off')
    }
  })

  it('routes the measured read set by partition, retired lanes to recombinations', () => {
    const w = NULL_SPLIT
    expect(w).toContain('frame.mvp')
    expect(w).toContain('frame.proj_params')
    expect(w).toContain('frame.globe_eye')
    expect(w).toContain('frame.log_depth_fc')
    expect(w).toContain('show.stroke_color')
    expect(w).toContain('tile.tile_extent_m')
    expect(w).toContain('tile.clip_bounds')
    // retired: Mercator origin reads through the hi/lo pair's .xy, and the
    // cam rel / ECEF offset recombine from the absolute anchors.
    expect(w).toContain('tile.tile_origin_merc_hl')
    expect(w).toContain('frame.cam_merc_center_hl')
    expect(w).toContain('tile.tile_ecef_center_h')
    expect(w).toContain('frame.cam_ecef_center_h')
  })

  it('preserves auto-var identity (no var fission, no zero-collapse)', () => {
    const legacy = emitLineWgsl(null, false)
    const countAv = (s: string) => [...s.matchAll(/var _av\d+/g)].length
    expect(
      countAv(NULL_SPLIT),
      'split emit minted a different auto-var count than legacy — Expr identity broke',
    ).toBe(countAv(legacy))
  })

  it('the legacy emit is untouched by the transform existing (no split leak)', () => {
    const legacy = emitLineWgsl(null, false)
    expect(legacy).toContain('struct TileUniforms')
    expect(legacy).not.toContain('FrameBlock')
    expect(legacy).not.toContain('ShowBlock')
    expect(legacy).not.toContain('TileBlock')
  })
})
