// ═══ #1494 — the hillshade derivative scale is PER TILE, not per frame ═══
//
// Symptom: neighbouring hillshade tiles shaded at visibly different brightness.
// Cause: the Sobel derivative scale was computed once per frame from the CAMERA
// zoom and shipped in a frame uniform, but the quantity it encodes — metres of
// elevation per DEM texel — is set by the zoom of the TILE being drawn. Any tile
// that is not a leaf at the camera's zoom (a parent fallback; a magnified leaf of
// a DEM whose source `maxzoom` stops shallow, #1489) was therefore scaled by
// 2^Δz too much or too little, and 2^Δz is already a doubling at Δz = 1.
//
// SINGLE AUTHORITY: the fixed scale lives in ONE place — the `hs_deriv_scale` DSL
// fn (hillshade.ts) — which both emits to WGSL/GLSL and is CPU-evaluated here via
// compileModule, so these gates test the exact arithmetic the shader runs rather
// than a hand mirror of it.
//
// The two mechanisms are severed independently:
//   • the ARITHMETIC — checked against the MapLibre closed form (the `spec` oracle
//     below, transcribed from hillshade_prepare.fragment.glsl, which is what the
//     removed per-frame `hillshadeDerivScale` computed). Break the ramp or the
//     constant and the closed-form comparison fails.
//   • the WIRING — the fragment must read the span from the TILE. No arithmetic
//     check can see this: replacing the argument with a constant leaves every
//     closed-form comparison green. The first attempt at this gate searched the
//     emitted fragment for /merc_y/ and was VACUOUS — the TileUniforms declaration
//     and the `abs_merc_y` varying match it either way, so it passed with the wire
//     cut. What discriminates is the call SITE, asserted below.

import { describe, it, expect } from 'vitest'
import { module, compileModule, emitGlslStages } from '@xgis/shader-dsl'
import { hsDerivScale, buildHillshadeModule, emitHillshadeWgsl } from './hillshade'
import { hillshadeDerivBase } from '../../render/hillshade-renderer'
import { PROJECTION_CONSTS } from './projections'

const M = compileModule(module({ consts: PROJECTION_CONSTS, funcs: [hsDerivScale] }))

/** MapLibre's closed form (hillshade_prepare.fragment.glsl), the design §3 step-2
 *  formula in full: tileSize / 2^(exaggeration_zoom + 28.2562 − zoom), where
 *  exaggeration_zoom = (zoom−15)·k below z15 and 0 at/above it. */
const spec = (tileSize: number, zoom: number) =>
  tileSize /
  Math.pow(
    2,
    (zoom >= 15 ? 0 : (zoom - 15) * (zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3)) + 28.2562 - zoom,
  )

/** A Mercator tile row is exactly 2π/2^z tall in log(tan(π/4+φ/2)) units — the
 *  merc_y.y lane the raster packer writes, which is what the shader reads back. */
const mercSpan = (z: number) => (2 * Math.PI) / Math.pow(2, z)

/** CPU-eval the shader fn for a tile at zoom `z` drawn from a `tileSize` DEM. */
const derivScale = (tileSize: number, z: number) =>
  M.fns.hs_deriv_scale(hillshadeDerivBase(tileSize), mercSpan(z)) as number

describe('#1494 hs_deriv_scale — arithmetic matches the MapLibre closed form', () => {
  it('every zoom level, both DEM tile sizes', () => {
    for (const tileSize of [256, 512]) {
      for (let z = 0; z <= 18; z++) {
        // Relative comparison: the values span 1e-4 … 1e-1 across the range, so an
        // absolute tolerance would be vacuous at the small end.
        expect(
          derivScale(tileSize, z) / spec(tileSize, z),
          `tileSize=${tileSize} z=${z}`,
        ).toBeCloseTo(1, 5)
      }
    }
  })

  it('the exaggeration ramp switches slope at z2 and z4.5, and flattens at z15', () => {
    // k = 0.4 below z2 — the ratio to the un-exaggerated 2^z law pins which k ran.
    const unexaggerated = (z: number) => hillshadeDerivBase(512) * Math.pow(2, z)
    expect(derivScale(512, 1) / unexaggerated(1)).toBeCloseTo(Math.pow(2, 14 * 0.4), 4)
    expect(derivScale(512, 3) / unexaggerated(3)).toBeCloseTo(Math.pow(2, 12 * 0.35), 4)
    expect(derivScale(512, 10) / unexaggerated(10)).toBeCloseTo(Math.pow(2, 5 * 0.3), 4)
    // At/above z15 the ramp is gone: the scale is exactly base·2^z.
    for (const z of [15, 16, 18]) expect(derivScale(512, z) / unexaggerated(z)).toBeCloseTo(1, 5)
  })
})

describe('#1494 hs_deriv_scale — the scale follows the TILE, not the frame', () => {
  it('one zoom level of difference moves the scale, in the correct direction', () => {
    // A z15 leaf and its z14 parent, drawn in the SAME frame, must not share a
    // scale: the parent covers twice the ground per texel, so its derivative is
    // worth less slope. This is the whole defect — a frame-wide scale gives both
    // tiles the identical number.
    // Above z15 the ramp is flat, so a level is exactly 2×. Across the z15 knee it
    // is 2^(14.3−15) = 2^−0.7, the halving softened by the exaggeration ramp.
    expect(derivScale(512, 16) / derivScale(512, 15)).toBeCloseTo(2, 5)
    expect(derivScale(512, 14) / derivScale(512, 15)).toBeCloseTo(Math.pow(2, -0.7), 5)
    expect(derivScale(512, 15)).toBeGreaterThan(derivScale(512, 14))
  })

  it('a magnified leaf keeps its OWN zoom’s scale, whatever the camera does', () => {
    // The camera zoom no longer reaches the shader at all, so a z15 terrarium leaf
    // magnified at camera z18 gets exactly the z15 scale — one value, not three.
    const leaf = derivScale(256, 15)
    expect(leaf).toBeCloseTo(spec(256, 15), 10)
    expect(leaf).not.toBeCloseTo(spec(256, 18), 10)
  })
})

describe('#1494 wiring — the fragment reads the per-tile Mercator span', () => {
  // The ARGUMENT is the assertion, not the mention. A bare /merc_y/ search over the
  // fragment is vacuous: the TileUniforms declaration and the `abs_merc_y` varying
  // both match it whatever the call passes, so severing the wire to a constant left
  // that check green. This pins the call SITE — the second argument must be the tile
  // lane — which is the only spelling a frame-wide scale cannot produce.
  const CALL = /hs_deriv_scale\(hs\.hs_texel\.y, tile\.merc_y\.y\)/

  it('every specialised method’s GLSL fragment passes tile.merc_y.y', () => {
    for (let methodFlag = 0; methodFlag <= 4; methodFlag++) {
      const frag = emitGlslStages(buildHillshadeModule(false, methodFlag)).fragment
      expect(frag, `method ${methodFlag} must scale by the TILE's own span`).toMatch(CALL)
    }
  })

  it('the un-specialised (runtime-dispatch) GLSL fragment passes it too', () => {
    expect(emitGlslStages(buildHillshadeModule(false, -1)).fragment).toMatch(CALL)
  })

  it('the WGSL half of the dual-source contract carries the same call', () => {
    // WebGL2 reads vsCode/fsCode and WebGPU reads `code` (#783) — a fix that landed
    // in only one of them would leave the other backend shading at the old contrast.
    expect(emitHillshadeWgsl(false, 1)).toMatch(CALL)
    expect(emitHillshadeWgsl(true, -1)).toMatch(CALL)
  })
})
