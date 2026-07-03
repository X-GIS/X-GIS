// ═══════════════════════════════════════════════════════════════════
// polygon-worldcopy-fill.test.ts — Mercator world-copy fill gap gate
// ═══════════════════════════════════════════════════════════════════
//
// Pins the world-copy fill-gap fix in the flat-Mercator polygon FILL
// arm (polygon.ts:emitPolygonProjectionLadder, the `proj_params.x < 0.5`
// branch).
//
// THE BUG (OFM Bright, mercator, zoom 0.5, lon 180): the wo=-1 world
// copy (Asia, left half of the canvas) rendered ONLY country-boundary
// LINES on black — no polygon fills, no synthetic background band. The
// wo=0 copy (Americas, right half) was fully filled.
//
// ROOT: the flat-Mercator FILL arm algebraically CANCELS the world-copy
// offset. The shader computes
//     p2d   = project(abs_lon, abs_lat)                 // PRIMARY-world
//                                                       // absolute X
//                                                       // (worldOff-blind)
//     rel2d = (p2d - tile_origin_merc) - cam_h - cam_l
// From the CPU pack (vector-tile-renderer.ts:5014-5019):
//     tile_origin_merc.x = (tileWest + worldOff) · DEG2RAD · R
//     cam_h + cam_l      = camMercX − tileMercX
// Substituting, the (tileWest + worldOff) terms CANCEL:
//     rel2d.x = abs_lon · DEG2RAD · R − camMercX
// so EVERY world copy collapses onto the primary world → the wo=-1 fill
// draws at the SAME screen x as wo=0. The LINE arm reconstructs from
// tile-local Mercator metres that carry worldOff via tile_origin_merc,
// so worldOff SURVIVES there → lines render the correct shifted copy.
//
// THE FIX: re-add the per-copy shift the non-Mercator sibling already
// applies (flat_rel → project_geom world_off_m). Recover the tile's true
// copy index from its displayed centre lon and add wo · 2π · EARTH_R:
//     tile_ref_lon = (tile_origin_merc.x + 0.5·tile_extent_m)/(DEG2RAD·R)
//     wo           = floor((tile_ref_lon + 180)/360)   // true copy index
//     world_off_m  = wo · 2π · EARTH_R
//     rel2d.x     += world_off_m
//
// The wo derivation is CAMERA-INDEPENDENT: the worldOff baked into
// tile_origin_merc is an exact 360° multiple, so tile_ref_lon =
// primary_centre_lon + wo·360 with primary_centre_lon ∈ [−180,180),
// hence floor((tile_ref_lon+180)/360) = wo exactly for ANY camera lon —
// including the ±180 antimeridian (the bug's own view). A clon-relative
// floor (the non-Mercator arm's form) would be off-by-one at clon=±180.
//
// This gate is pure CPU math (no GPU) mirroring the two VS arms with the
// pack formulas, plus a string companion that greps the emitted Mercator
// WGSL arm for the world_off_m add.

import { describe, it, expect } from 'vitest'
import { emitPolygonWgsl } from './polygon'

// WGSL-truncated constants — the shader runs these exact f32 literals
// (projections.ts PROJECTION_CONSTS wgslValue). Using them (not full
// Math.PI) keeps the CPU mirror faithful to the GPU arm.
const PI = 3.14159265
const DEG2RAD = 0.01745329
const EARTH_R = 6378137
const CIRC = 2 * PI * EARTH_R

// ── CPU mirror of the CPU uniform pack (vector-tile-renderer.ts) ──
// tile_origin_merc.x and cam_h+cam_l as the renderer writes them.
function tileMercX(tileWestPrimary: number, worldOffDeg: number): number {
  return Math.fround((tileWestPrimary + worldOffDeg) * DEG2RAD * EARTH_R)
}
function camRelX(tileWestPrimary: number, worldOffDeg: number, clon: number): number {
  // cam_h + cam_l = camMercX − tileMercX (the f64-cancellation split,
  // collapsed here since we only need the sum).
  return clon * DEG2RAD * EARTH_R - tileMercX(tileWestPrimary, worldOffDeg)
}

// ── FILL arm — BASELINE (the bug: no world_off_m) ──
function fillRelBaseline(
  absLon: number,
  tileWestPrimary: number,
  worldOffDeg: number,
  clon: number,
): number {
  const tm = tileMercX(tileWestPrimary, worldOffDeg)
  const p2dx = absLon * DEG2RAD * EARTH_R
  return p2dx - tm - camRelX(tileWestPrimary, worldOffDeg, clon)
}

// ── FILL arm — FIXED (adds world_off_m, mirroring the shader edit) ──
function fillRelFixed(
  absLon: number,
  tileWestPrimary: number,
  worldOffDeg: number,
  clon: number,
  tileExtentM: number,
): { rel: number; wo: number } {
  const tm = tileMercX(tileWestPrimary, worldOffDeg)
  const tileRefLon = (tm + 0.5 * tileExtentM) / (DEG2RAD * EARTH_R)
  const wo = Math.floor((tileRefLon + 180) / 360)
  const worldOffM = wo * 2 * PI * EARTH_R
  return { rel: fillRelBaseline(absLon, tileWestPrimary, worldOffDeg, clon) + worldOffM, wo }
}

// ── LINE arm — reconstructs from tile-local Mercator metres ──
// p_h/p_l = (abs_merc_in_copy − tile_origin_merc); line_endpoint
// subtracts cam_h/cam_l. worldOff SURVIVES because abs_merc_in_copy
// carries it.
function lineRel(
  absLon: number,
  tileWestPrimary: number,
  worldOffDeg: number,
  clon: number,
): number {
  const tm = tileMercX(tileWestPrimary, worldOffDeg)
  const pLocal = (absLon + worldOffDeg) * DEG2RAD * EARTH_R - tm
  return pLocal - camRelX(tileWestPrimary, worldOffDeg, clon)
}

// z0 whole-world tile: tileWest = −180, extent = 360°.
const Z0_EXTENT_M = 360 * DEG2RAD * EARTH_R
const TILE_WEST_Z0 = -180

describe('Mercator world-copy fill-gap — CPU two-arm parity gate', () => {
  // The bug's view: OFM Bright, mercator, zoom 0.5, lon 180. Camera
  // lon 180 → centerX = +WORLD_MERC → clon = +180 (positive). The fix
  // must also hold at clon = −180 (same longitude) and out-of-range.
  const VERTEX_ABS_LON = 120 // an Asia vertex, present in wo=0 AND wo=-1

  it('LINE arm: rel changes by ~worldOff·DEG2RAD·R between copies (correct today)', () => {
    // f32 ULP of the ~10^7 m tile origin (~4-16 m) leaks into the line
    // arm's per-copy reconstruction; 50 m is ~0.0006 px at z0.
    const F32_ULP_M = 50
    for (const clon of [180, -180, 170, -170, 0]) {
      const l0 = lineRel(VERTEX_ABS_LON, TILE_WEST_Z0, 0, clon)
      const lm1 = lineRel(VERTEX_ABS_LON, TILE_WEST_Z0, -360, clon)
      // worldOff = −360° → shift = −360·DEG2RAD·R = −CIRC.
      expect(Math.abs(lm1 - l0 - -CIRC)).toBeLessThan(F32_ULP_M)
    }
  })

  it('FILL arm BASELINE: world copies COLLAPSE (the bug — diff ≈ 0, not a world circumference)', () => {
    for (const clon of [180, -180, 0]) {
      const f0 = fillRelBaseline(VERTEX_ABS_LON, TILE_WEST_Z0, 0, clon)
      const fm1 = fillRelBaseline(VERTEX_ABS_LON, TILE_WEST_Z0, -360, clon)
      // Bug signature: the two copies land at the SAME rel2d.x.
      expect(Math.abs(fm1 - f0)).toBeLessThan(1)
    }
  })

  it('FILL arm FIXED: world copies SEPARATE by a full world circumference (the fix)', () => {
    for (const clon of [180, -180, 170, -170, 0]) {
      const f0 = fillRelFixed(VERTEX_ABS_LON, TILE_WEST_Z0, 0, clon, Z0_EXTENT_M).rel
      const fm1 = fillRelFixed(VERTEX_ABS_LON, TILE_WEST_Z0, -360, clon, Z0_EXTENT_M).rel
      // Fixed fill now shifts by exactly one circumference — matching
      // the LINE arm's behaviour (lines + fills agree per copy).
      expect(Math.abs(Math.abs(fm1 - f0) - CIRC)).toBeLessThan(1)
    }
  })

  it('FILL arm FIXED agrees with the LINE arm per copy at EVERY camera lon (incl. antimeridian)', () => {
    // Tolerance: the f32 quantization of tile_origin_merc (~10^7 m
    // magnitude) gives an ULP of ~4-16 m. The two arms round the shared
    // tile origin into slightly different residuals, so allow 50 m —
    // ~0.0006 px at z0 (1 px ≈ 78 km). Far tighter than a world copy
    // (the bug's collapse was a FULL circumference, 4·10^7 m).
    const F32_ULP_M = 50
    for (const clon of [180, -180, 170, -170, 0, 90, -90, 200, -200]) {
      for (const woDeg of [0, -360, 360, -720, 720]) {
        const f = fillRelFixed(VERTEX_ABS_LON, TILE_WEST_Z0, woDeg, clon, Z0_EXTENT_M).rel
        const l = lineRel(VERTEX_ABS_LON, TILE_WEST_Z0, woDeg, clon)
        expect(Math.abs(f - l), `clon=${clon} woDeg=${woDeg}`).toBeLessThan(F32_ULP_M)
      }
    }
  })

  it('REGRESSION: single-copy primary tile (wo=0) is BYTE-IDENTICAL baseline-vs-fix', () => {
    // City / single-world views must not change: world_off_m === 0 there.
    // Camera centred near the tile (clon ≈ tile centre lon), worldOff = 0.
    const cases: Array<[string, number, number, number, number]> = [
      // name, clon, tileWest, absLon, zoom
      ['Seoul z14', 127.5, 127.001, 127.01, 14],
      ['Tokyo z12', 139.7, 139.69, 139.71, 12],
      ['Paris z12', 2.35, 2.34, 2.36, 12],
      ['demotiles z2', 0.0, -45.0, -30.0, 2],
    ]
    for (const [name, clon, tw, al, z] of cases) {
      const extM = (360 / Math.pow(2, z)) * DEG2RAD * EARTH_R
      const base = fillRelBaseline(al, tw, 0, clon)
      const { rel: fixed, wo } = fillRelFixed(al, tw, 0, clon, extM)
      expect(wo, `${name}: wo must be 0 for a single-copy primary tile`).toBe(0)
      // wo=0 ⇒ +0 ⇒ exactly byte-identical (no f32 perturbation).
      expect(fixed, `${name}: fill must be byte-identical baseline-vs-fix`).toBe(base)
    }
  })

  it('wo derivation recovers the true copy index across zooms/copies (f32-stable)', () => {
    // The worldOff baked into tile_origin_merc is an exact 360° multiple,
    // so floor((tile_ref_lon+180)/360) MUST equal the copy index for any
    // tile/zoom/copy, byte-stable under the WGSL-truncated f32 constants.
    let mismatches = 0
    for (const z of [0, 1, 2, 3, 5, 8, 12, 14, 18]) {
      const tn = Math.pow(2, z)
      const extM = Math.fround((360 / tn) * DEG2RAD * EARTH_R)
      for (let xi = 0; xi < Math.min(tn, 64); xi++) {
        const twPrimary = (xi / tn) * 360 - 180
        for (const cw of [-2, -1, 0, 1, 2]) {
          const { wo } = fillRelFixed(0, twPrimary, cw * 360, 0, extM)
          if (wo !== cw) mismatches++
        }
      }
    }
    expect(mismatches).toBe(0)
  })
})

describe('Mercator world-copy fill-gap — emitted WGSL string companion', () => {
  // The production polygon shader's Mercator FILL arm must contain the
  // world_off_m add. This catches a revert of the fix even if the pure-
  // math gate above (which is self-contained) still passes.
  const wgsl = emitPolygonWgsl(null, false)

  it('emits the world-copy offset derivation in the Mercator fill arm', () => {
    // The CSE auto-cache inlines/renames the hand `let world_off_m` and
    // `let wo`/`tile_ref_lon`, so assert the SEMANTIC structure of the
    // Mercator FILL arm's world-copy offset instead of the binding names.
    //
    // The fill arm's copy index is a CAMERA-INDEPENDENT floor over the
    // tile_ref_lon = (tile_origin_merc.x + 0.5·tile_extent_m)/(DEG2RAD·R)
    // term — the `tile_extent_m` operand is what distinguishes it from the
    // clon-RELATIVE floors in the flat_rel/project_geom helper bodies
    // (which subtract proj_params.y before +180). The optimizer cse-hoists
    // tile_ref_lon into a temp, so assert (1) that ref-lon expression exists
    // (inline or as the temp's definition) and (2) the +180/360 copy-index
    // floor over the (now \w+ cse-temp) ref-lon, proving the floor survives.
    expect(wgsl).toMatch(
      /\(\(u\.tile_origin_merc\.x \+ \(0\.5 \* u\.tile_extent_m\)\) \/ \(DEG2RAD \* EARTH_R\)\)/,
    )
    // world_off_m = wo · 2π · EARTH_R: the floored copy index multiplied by
    // the world circumference (`... floor(((<refLon> + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R`).
    // The +180/360 floor (not the clon-relative `- _cseN`/`+ 0.5` helper floor)
    // pins the FILL arm's add; \w+ is the cse-hoisted tile_ref_lon temp.
    expect(wgsl).toMatch(/floor\(\(\(\w+ \+ 180\.0\) \/ 360\.0\)\) \* 2\.0\) \* PI\) \* EARTH_R\)/)
  })

  it('adds world_off_m to rel2d.x before the MVP transform (fill + extrude)', () => {
    // Both the flat fill (z=0.0) and the extruded (z=z_plane) Mercator
    // arms apply the shift. CSE renames `rel2d` to a \w+ cse temp and
    // inlines `world_off_m` (the floor·circumference term) plus, for the
    // extruded arm, the `z_plane` wall-height into a \w+ cse temp. Assert
    // the shifted vec4: (<rel>.x + <world_off_m add>), <rel>.y, <z>, 1.0 —
    // generalizing only the bound NAMES, keeping the x-add + structure.
    // The world_off_m add is the same `... * 2.0) * PI) * EARTH_R)` term
    // pinned above, so the x-channel really carries the world-copy offset.
    const worldOff = String.raw`\(\(\(floor\([^;]*\) \* 2\.0\) \* PI\) \* EARTH_R\)`
    // x channel: vec4<f32>(( <rel>.x + <world_off_m> ), <rel>.y, <z>, 1.0)
    // — the vec4 arg-list paren + the x-group paren wrap the shifted x.
    // Flat fill: z slot is the literal 0.0.
    expect(wgsl).toMatch(
      new RegExp(String.raw`vec4<f32>\(\((\w+)\.x \+ ${worldOff}\), \1\.y, 0\.0, 1\.0\)`),
    )
    // Extruded: z slot is the wall-height z_plane (a \w+ cse temp / inlined
    // expression), NOT the literal 0.0 — so match a non-0.0 z channel.
    expect(wgsl).toMatch(
      new RegExp(String.raw`vec4<f32>\(\((\w+)\.x \+ ${worldOff}\), \1\.y, \w+, 1\.0\)`),
    )
  })

  it('does NOT perturb the non-Mercator (flat_rel) arm', () => {
    // The non-Mercator sibling keeps its own world-copy handling inside
    // project_geom — the fix must not touch it. CSE renames the `rel2d_geom`
    // binding to a \w+ cse temp and inlines the `tile_ref_lon` arg, so assert
    // the flat_rel CALL with its stable leading operands (abs_lon, abs_lat,
    // u.proj_params) — the same shared-helper invocation, unchanged by the
    // Mercator-arm fix.
    expect(wgsl).toMatch(/flat_rel\(abs_lon, abs_lat, u\.proj_params,/)
  })
})
