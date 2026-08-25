// ═══ #2042 INC-4a — split-mode polygon emit: structure + transform
//     completeness gate ═══
//
// buildPolygonSplitModule derives the three-block shader from the legacy
// module by IR rewrite (polygon-split.ts). This gate is what makes a missed
// rewrite LOUD instead of a silent wrong-lane read:
//   1. the split WGSL declares FrameBlock(11)/ShowBlock(10)/TileBlock(7)
//      and NOT the legacy Uniforms(0);
//   2. NO `u.` read survives anywhere (DSL member reads and compiler
//      splices alike) — the emit-time throw covers unmapped fields, this
//      covers "mapped but to the wrong spelling";
//   3. the derived-lane rewrites land where they must (rim flag →
//      show.fill_antialias, dequant → tile.*, mvp → frame.*);
//   4. compiler-spliced dotted varrefs route by partition, and a spliced
//      read of a retired lane throws;
//   5. the LEGACY emit is untouched by importing the transform (same
//      byte-guarantee the variant snapshots pin — asserted cheaply here as
//      "no split struct leaks into legacy").

import { describe, it, expect } from 'vitest'
import { Node, vec4fT } from '@xgis/shader-dsl'
import { emitPolygonWgsl, type PolygonVariantSpec } from './polygon'
import { emitPolygonSplitWgsl } from './polygon-split'

const NULL_SPLIT = emitPolygonSplitWgsl(null, false)
const NULL_SPLIT_PICK = emitPolygonSplitWgsl(null, true)

const splicedVariant = (name: string): PolygonVariantSpec => ({
  preamble: null,
  fillExpr: new Node<'vec4<f32>'>({ op: 'varref', type: vec4fT, name }),
  strokeExpr: null,
  fillPreamble: null,
  strokePreamble: null,
  needsFeatureBuffer: false,
})

describe('#2042 INC-4a — split-mode polygon emit', () => {
  it('declares the three blocks at their reserved group-0 bindings, and no legacy block', () => {
    for (const w of [NULL_SPLIT, NULL_SPLIT_PICK]) {
      expect(w).toContain('struct FrameBlock')
      expect(w).toContain('struct ShowBlock')
      expect(w).toContain('struct TileBlock')
      expect(w).toContain('@group(0) @binding(11) var<uniform> frame: FrameBlock;')
      expect(w).toContain('@group(0) @binding(10) var<uniform> show: ShowBlock;')
      expect(w).toContain('@group(0) @binding(7) var<uniform> tile: TileBlock;')
      expect(w).not.toContain('struct Uniforms')
      expect(w).not.toMatch(/@binding\(0\)\s+var<uniform>/)
    }
  })

  it('NO legacy `u.` read survives the transform (the completeness tripwire)', () => {
    for (const w of [NULL_SPLIT, NULL_SPLIT_PICK]) {
      expect(w).not.toMatch(/\bu\./)
      expect(w).not.toContain('cam_ecef_off')
      // sprite bindings survive untouched (non-uniform resources)
      expect(w).toContain('@group(0) @binding(5) var sprite_atlas')
      expect(w).toContain('@group(0) @binding(6) var sprite_samp')
    }
  })

  it('routes each partition class to its block, and derived lanes to their recombinations', () => {
    const w = NULL_SPLIT
    expect(w).toContain('frame.mvp')
    expect(w).toContain('frame.proj_params')
    expect(w).toContain('frame.globe_eye')
    expect(w).toContain('show.fill_color')
    expect(w).toContain('show.opacity')
    // the rim gate's flag lane relocated from cam_ecef_off_h.w:
    expect(w).toContain('show.fill_antialias')
    expect(w).toContain('tile.tile_dequant_scale')
    expect(w).toContain('tile.clip_bounds')
    // the retired Mercator origin reads through the hi/lo pair's .xy:
    expect(w).toContain('tile.tile_origin_merc_hl')
    // the RTC recombination reads both absolute anchors:
    expect(w).toContain('tile.tile_ecef_center_h')
    expect(w).toContain('frame.cam_ecef_center_h')
  })

  it('compiler-spliced dotted varrefs route by partition (frame + show lanes)', () => {
    const wInput = emitPolygonSplitWgsl(splicedVariant('u.input_color_0'), false)
    expect(wInput).toContain('frame.input_color_0')
    expect(wInput).not.toMatch(/\bu\./)
    const wFill = emitPolygonSplitWgsl(splicedVariant('u.fill_color'), false)
    expect(wFill).toContain('show.fill_color')
  })

  it('a spliced read of a retired lane THROWS at build time (no silent zeros)', () => {
    expect(() => emitPolygonSplitWgsl(splicedVariant('u.cam_h'), false)).toThrow(
      /no destination block/,
    )
  })

  it('the legacy emit is untouched by the transform existing (no split leak)', () => {
    const legacy = emitPolygonWgsl(null, false)
    expect(legacy).toContain('struct Uniforms')
    expect(legacy).not.toContain('FrameBlock')
    expect(legacy).not.toContain('ShowBlock')
    expect(legacy).not.toContain('TileBlock')
  })
})
