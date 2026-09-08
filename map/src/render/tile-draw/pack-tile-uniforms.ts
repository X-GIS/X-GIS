import type { VectorTileRenderer } from '../vector-tile-renderer'
import type { GPUTile } from '../vector-tile-renderer-types'
import type { TilePackCtx, TilePackOut } from './types'
import { TWO_PI_R_EARTH } from '../vector-tile-renderer-helpers'
import { computeTileCameraAnchor, clampMercLat } from '../tile-camera-anchor'
import { tileKeyUnpack } from '@xgis/compiler'
import { isOverdrawActive } from '../../debug-flags'

/** Repo idiom (`geo/src/globe.ts:31`, `shared/src/ecef.ts:31`): a file-local
 *  radians constant rather than an import. */
const DEG2RAD = Math.PI / 180

/** #2508 step 3 — pack ONE tile's uniform slot: the fade/opacity state, the
 *  RTC anchors, the clip rect, the light block, and either the split bind or a
 *  ring allocation. The caller runs it only when the walk-skip did not already
 *  supply a split bind (`if (!skipPack)`), and reads the four values it produces
 *  back out of `out`. */
export function packTileUniforms(
  vtr: VectorTileRenderer,
  ctx: TilePackCtx,
  out: TilePackOut,
  ki: number,
  key: number,
  worldOff: number,
  visibleKey: number,
  cached: GPUTile,
): void {
  // Tile pop-in: new tiles appear immediately at full opacity.
  // A fade-in used to ramp alpha 0→1 over ~10 frames, but that made
  // each newly-loaded tile visually EMPTY for 10 frames (no fallback
  // once the child is cached), producing a continuous flicker during
  // active zoom as tiles finish loading one by one. Instant pop-in is
  // visually cleaner and matches the loading sequence's natural cadence.
  const baseFillA = vtr.cachedFillColor[3] * (vtr.currentOpacity ?? 1.0)
  const baseStrokeA = vtr.cachedStrokeColor[3] * (vtr.currentOpacity ?? 1.0)
  // When a pattern is active, render() packed the sprite atlas UV bbox
  // into the fill_color slot (fill, v1 = fill_color.a) / the stroke_color
  // slot (line, v1 = stroke_color.a). The fragment shader reads
  // fill_color.a / stroke_color.a as the pattern's v1; clobbering it with
  // the alpha here corrupts the UV (black/garbage pattern). Same guard as
  // the fill_translate slots below — only write the alpha when NO pattern
  // owns the slot.
  if (!vtr._patternUniformActive) {
    // Alpha-only refresh — RGB re-written with its current cached values
    // (the pattern guard above means the slot holds cachedFillColor RGB).
    vtr.frameBlock.set.fill_color(
      vtr.cachedFillColor[0]!,
      vtr.cachedFillColor[1]!,
      vtr.cachedFillColor[2]!,
      baseFillA,
    )
  }
  if (!vtr._linePatternActiveForShow) {
    vtr.frameBlock.set.stroke_color(
      vtr.cachedStrokeColor[0]!,
      vtr.cachedStrokeColor[1]!,
      vtr.cachedStrokeColor[2]!,
      baseStrokeA,
    )
  }
  // u.opacity for shader variants is written at index 34 (offset 136 in
  // the 192-byte layout) in the DSFUN uniform block, below — keep it off
  // the pre-tile pack so we only write it once per slot.

  // DSFUN uniform pack — Mercator cam_h/cam_l + ellipsoid ECEF RTC offset,
  // computed by the SINGLE anchor authority (tile-camera-anchor.ts, #1044:
  // the frame-consistency rationale — ellipsoid camera term, no worldOff on
  // ECEF, hi/lo splits — lives there; the WebGL2 twin packs share it so the
  // seam cannot drift again).
  const anchor = computeTileCameraAnchor(
    cached.tileWest,
    cached.tileSouth,
    worldOff,
    ctx.projCenterLon,
    ctx.projCenterLat,
  )
  vtr.frameBlock.set.cam_h(anchor.camXH, anchor.camYH)
  vtr.frameBlock.set.cam_l(anchor.camXL, anchor.camYL)
  // Mapbox opt-out flags ride the spare .w lanes of the two cam_ecef_off
  // vec4s (the VS only reads .xyz, so .w is free):
  //   cam_ecef_off_h.w = fill-antialias (1 default, 0 = off)
  //   cam_ecef_off_l.w = fill-extrusion-vertical-gradient
  vtr.frameBlock.set.cam_ecef_off_h(
    anchor.ecefXH,
    anchor.ecefYH,
    anchor.ecefZH,
    vtr.currentFillAntialias,
  )
  vtr.frameBlock.set.cam_ecef_off_l(
    anchor.ecefXL,
    anchor.ecefYL,
    anchor.ecefZL,
    vtr.currentFillVerticalGradient,
  )
  vtr._writeRtcAnchors(anchor)
  // #2042 INC-2 — establish the persistent TileBlock slot for this
  // (slice, tile, worldCopy) on its first UNCLIPPED draw (packed once;
  // freed via _releaseTileHook). Clip-fallback draws (visibleKey ≥ 0)
  // keep the ring path: their clip_bounds is per visible descendant
  // (see tile-uniform-arena.ts's header). Nothing binds the slot until
  // INC-4 — this is the lifecycle + bytes-parity half landing first.
  if (visibleKey < 0 && ctx.sliceLayer !== '') {
    vtr._tileUniforms.ensureSlot(
      ctx.sliceLayer,
      key,
      worldOff,
      anchor,
      TWO_PI_R_EARTH / Math.pow(2, cached.tileZoom),
      cached.dequantScale,
      cached.dequantHalf,
    )
  }

  // light_dir_ecef (60-62) — #420. On the sphere family the extrude VS
  // dots the per-vertex ECEF face_normal against this; the raw MapLibre
  // light (0.288,-0.498,0.996) is a tile/viewport-frame constant, so
  // against an ECEF normal it gave arbitrary per-face brightness (roof
  // mid, one wall spikes to 1, rest at the 0.5 dark floor). Rotating it
  // (East,North,Up) into ECEF by the camera-anchor ENU→ECEF basis fixed
  // that NEAR THE ANCHOR — polygon-mesh.ts builds each normal in the
  // VERTEX's own ENU frame (East=(-sLon,cLon,0), North=(-sLat·cLon,
  // -sLat·sLon,cLat), Up=(cLat·cLon,cLat·sLon,sLat)), so anchor-rotated
  // light drifts at continental distance (#1198). .w (63) = intensity.
  // Convert the Mapbox light position [radius, azimuth°, polar°] to an
  // (East,North,Up) direction via MapLibre's sphericalToCartesian
  // (azimuth +90° so 0° points north). The default [1.15,210,30]
  // reproduces the old baked (0.288,-0.498,0.996).
  const [lRad, lAz, lPol] = vtr._lightPosition
  const lAzR = (lAz + 90) * DEG2RAD,
    lPolR = lPol * DEG2RAD
  const LE0 = lRad * Math.cos(lAzR) * Math.sin(lPolR)
  const LN0 = lRad * Math.sin(lAzR) * Math.sin(lPolR)
  const LU = lRad * Math.cos(lPolR)
  // Mapbox `light.anchor` defaults to VIEWPORT: the light is fixed to the
  // SCREEN, so rotating the map must rotate the light with it (MapLibre
  // premultiplies u_lightpos by mat3.fromRotation(bearing) in
  // fillExtrusionUniformValues). Without it the lit/unlit wall sets stay
  // pinned to true north and every camera-facing wall darkens to the floor
  // once the map turns — at bearing 90 over London, 14.6 % of the frame sat
  // at the darkest shade against MapLibre's 2.1 %. Rotation DIRECTION is
  // measurement-established, not frame-derived: see
  // map/src/render/extrude-light-bearing.test.ts for the A/B. `anchor: map`
  // is not plumbed through the style pipeline yet; when it is, it skips this.
  const bR = vtr.currentBearingDeg * DEG2RAD
  const bC = Math.cos(bR),
    bS = Math.sin(bR)
  const LE = LE0 * bC + LN0 * bS
  const LN = -LE0 * bS + LN0 * bC
  // Intensity → light_dir_ecef.w; colour → RGBA8 packed into
  // light_color_packed (u32 lane — routed through the block's raw-word
  // view). The extrude VS reads both; all other variants ignore them.
  //
  // #1198 — frame-matched packing: flat projections ship the RAW
  // viewport-frame light (the extrude VS dots it in the vertex's own ENU
  // frame — position-invariant, MapLibre-exact); the sphere family keeps
  // the anchor ENU→ECEF rotation (#420 sun). The VS selects the same
  // frame off proj_params.x < 6.5.
  if (vtr.currentProjType < 6.5) {
    vtr.frameBlock.set.light_dir_ecef(
      Math.fround(LE),
      Math.fround(LN),
      Math.fround(LU),
      vtr._lightIntensity,
    )
  } else {
    vtr.frameBlock.set.light_dir_ecef(
      Math.fround(
        LE * -ctx.camSinLon +
          LN * (-ctx.camSin * ctx.camCosLon) +
          LU * (ctx.camCos * ctx.camCosLon),
      ),
      Math.fround(
        LE * ctx.camCosLon + LN * (-ctx.camSin * ctx.camSinLon) + LU * (ctx.camCos * ctx.camSinLon),
      ),
      Math.fround(/* LE*0 */ LN * ctx.camCos + LU * ctx.camSin),
      vtr._lightIntensity,
    )
  }
  const lc = vtr._lightColor
  const lr8 = Math.max(0, Math.min(255, Math.round(lc[0] * 255)))
  const lg8 = Math.max(0, Math.min(255, Math.round(lc[1] * 255)))
  const lb8 = Math.max(0, Math.min(255, Math.round(lc[2] * 255)))
  // unpack4x8unorm order: .x = byte 0 (LSB) = r, … so pack r|g<<8|b<<16.
  vtr.frameBlock.set.light_color_packed((lr8 | (lg8 << 8) | (lb8 << 16) | (255 << 24)) >>> 0)

  // (proj_params + globe_eye are frame-invariant — written once per frame in
  // render() via frameBlock.set.proj_params/globe_eye, and persist in the
  // block across every per-tile slot stage, exactly like they always have.)

  // tile_origin_merc (32-33) + opacity (34) + log_depth_fc (35)
  // — offsets 128..143. log_depth_fc was cached by camera.getRTCMatrix
  // and is shared across every tile drawn this frame.
  vtr.frameBlock.set.tile_origin_merc(anchor.tileMercX, anchor.tileMercY)
  vtr.frameBlock.set.opacity(vtr.currentOpacity ?? 1.0)
  vtr.frameBlock.set.log_depth_fc(vtr.logDepthFc)
  // pick_id (36) — packed (instanceId<<16)|layerId. instanceId is
  // 0 for now; future WORLD_COPIES instancing will pack it here.
  // Cached on the show by XGISMap after LayerIdRegistry.register().
  vtr.frameBlock.set.pick_id(vtr.currentPickId)
  // layer_depth_offset (37) — per-layer NDC-z bias to disambiguate
  // coplanar fills under log-depth (filter_gdp at pitch=46.5 z-fight
  // bug, 2026-05-04). 1e-3 per layer was empirically chosen to
  // overcome the log-depth precision compression at moderate pitch
  // (~10 effective bits at 85°). Layer index = pickId & 0xFFFF —
  // pickIds are assigned in style declaration order so this matches
  // the bucket scheduler's draw order.
  vtr.frameBlock.set.layer_depth_offset((vtr.currentPickId & 0xffff) * 1e-3)
  // tile_extent_m (38) — tile-local Mercator-meter extent at this
  // tile's zoom. vs_main_quantized dequants pos_norm via this.
  // 2π × R / 2^z; we cache R × 2π once per VTR.
  vtr.frameBlock.set.tile_extent_m(TWO_PI_R_EARTH / Math.pow(2, cached.tileZoom))
  // extrude_height_m (39) — 3D building extrusion height in
  // metres. Set in render() from show.sourceLayer (MVP: hard-
  // coded for `buildings`, 0 elsewhere). Per-feature heights
  // via PropertyTable + style `extrude:` syntax are a follow-up.
  vtr.frameBlock.set.extrude_height_m(vtr.currentExtrudeHeight)
  // clip_bounds (40-43) — per-tile mercator clip rect (west,
  // south, east, north). When `visibleKeysForClip` is provided
  // (fallback path), each draw clips to the visible tile it's
  // FILLING for — a parent z=11 ancestor rendered for a missing
  // z=15 child only draws within the z=15 child's mercator
  // extent, instead of overflowing into adjacent z=15 tiles
  // that have their OWN buildings. Sentinel west=-1e30 means
  // "no clip" for the primary path (fragment shader skips the
  // discard test).
  // Skip per-tile clip when the parent is z=0 root: at that
  // zoom the tile's data covers the WHOLE world, and the visible-
  // tile-selector's habit of returning only one z=1 child (e.g.
  // SE quadrant) at low camera zoom would clip the parent to
  // that quadrant — visible symptom: hero map shows only Africa
  // + Australia. Skipping the clip lets the parent render the
  // entire world for every visible-key fallback at z=0 (some
  // overdraw, but visually correct). The clip mechanism remains
  // active for higher-zoom fallback (z>0 parents do NOT contain
  // adjacent visible tiles' data so cross-tile spill is real).
  const parentIsRoot = cached.tileZoom === 0
  if (ctx.visibleKeysForClip && !parentIsRoot) {
    const visibleKey = ctx.visibleKeysForClip[ki]
    const [vz, vx, vy] = tileKeyUnpack(visibleKey)
    const vn = Math.pow(2, vz)
    const vWestLon = (vx / vn) * 360 - 180 + worldOff
    const vEastLon = ((vx + 1) / vn) * 360 - 180 + worldOff
    const vNorthLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * vy) / vn))) * 180) / Math.PI
    const vSouthLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (vy + 1)) / vn))) * 180) / Math.PI
    const clipPad = (2 * Math.PI * ctx.R) / (512 * Math.pow(2, vtr.currentCameraZoom)) // #1087
    vtr.frameBlock.set.clip_bounds(
      Math.fround(vWestLon * DEG2RAD * ctx.R) - clipPad,
      Math.fround(
        Math.log(Math.tan(Math.PI / 4 + (clampMercLat(vSouthLat) * DEG2RAD) / 2)) * ctx.R,
      ) - clipPad,
      Math.fround(vEastLon * DEG2RAD * ctx.R) + clipPad,
      Math.fround(
        Math.log(Math.tan(Math.PI / 4 + (clampMercLat(vNorthLat) * DEG2RAD) / 2)) * ctx.R,
      ) + clipPad,
    )
  } else {
    // Sentinel: no clip. Fragment shader's `clip_bounds.x > -1e29`
    // gate skips the discard test entirely.
    vtr.frameBlock.set.clip_bounds(-1e30, 0, 0, 0)
  }

  // zoom (44) — per-frame CONTINUOUS camera zoom (camera.zoom),
  // cached by render() into this.currentCameraZoom. Read by the
  // palette gradient sample (P3 Step 3c) + zoom-interp fills: the
  // variant shader maps (zoom - zMin) / span into the gradient
  // atlas's U coord. MUST be the fractional camera zoom — using
  // the integer this.lastZoom (tile-selection zoom) snaps fills +
  // gradients at integer boundaries instead of interpolating.
  vtr.frameBlock.set.zoom(vtr.currentCameraZoom)
  // extrude_base_m (45) — wall bottom z (Mapbox
  // `fill-extrusion-base`). Reuses the first `_pad_zoom_*` slot
  // without growing the uniform struct past 192 bytes.
  vtr.frameBlock.set.extrude_base_m(vtr.currentExtrudeBase)
  // fill-translate NDC-per-px (fill_translate_x/y slots) — pre-baked at
  // render() time using canvasWidth/Height. Vertex shader
  // applies via clip += offset * clip.w so the pixel offset
  // stays constant regardless of depth. Pattern shows overwrite the
  // same slots with the pattern repeat in Mercator metres
  // (fs_fill_pattern reads u.fill_translate as repeat_m for the
  // world-anchored UV). Pattern shows cannot also use fill-translate.
  // #1154 — pattern_active gates the VS fill-translate: a pattern fill packs
  // the world repeat (Mercator metres) into fill_translate_x/y, which the VS
  // must NOT apply as an NDC offset (it would fling the fill off-screen).
  if (vtr._patternUniformActive) {
    vtr.frameBlock.set.fill_translate_x(vtr._patternRepeatMX)
    vtr.frameBlock.set.fill_translate_y(vtr._patternRepeatMY)
    vtr.frameBlock.set.pattern_active(1)
  } else {
    vtr.frameBlock.set.fill_translate_x(vtr.currentFillTranslateNdcX)
    vtr.frameBlock.set.fill_translate_y(vtr.currentFillTranslateNdcY)
    vtr.frameBlock.set.pattern_active(0)
  }

  // tile_dequant_scale (48) + tile_dequant_half (49) — per-tile
  // quantized-position dequant. The polygon VS reconstructs each ECEF
  // RTC axis as `q = f32(hi)*65536 + f32(lo); axis = q*scale - half`.
  // These are per-tile (flat: tiler-computed; extruded: wall-mesh-
  // computed post-lift) so they MUST ride the per-tile uniform slot —
  // never a batched draw (confirmed: setBindGroup uses a per-tile
  // dynamic slotOffset, one alloc per tile in this loop).
  vtr.frameBlock.set.tile_dequant_scale(cached.dequantScale)
  vtr.frameBlock.set.tile_dequant_half(cached.dequantHalf)

  // Allocate a fresh ring slot for this tile × layer × world-copy draw.
  out.slotOffset = vtr.allocUniformSlot()
  // allocUniformSlot may have grown the ring → tileBgDefault /
  // tileBgFeature were rebuilt; re-resolve fillBg against the
  // FILL pipeline's layout (set by render() caller). Lines always
  // use baseBindGroupLayout, so currentLineTileBg is always the
  // default BG.
  //
  // For the feature-pipeline path prefer the tile-owned bind group
  // when present (MVT/PMTiles per-tile featureDataBuffer). The
  // source-level `this.tileBgFeature` is the GeoJSON path's
  // global-PropertyTable bind group; using it for MVT would index
  // a different (zero-filled) buffer and silently mis-route every
  // feature to the variant shader's fallback arm.
  // Feature-layout fill: per-tile (MVT) or source-level (GeoJSON) feature bg.
  // Either can be transiently null (e.g. a frame after a projection switch);
  // binding null with a dynamic offset corrupts the whole encoder (every
  // later draw + finish() fail → black screen) → resolve null, skip below.
  out.currentTileBg =
    ctx.fillBindGroupLayout === vtr._bindGroups.baseLayout()
      ? vtr._bindGroups.baseGroup()!
      : (cached.featureBindGroup ?? vtr._bindGroups.featureGroup() ?? null)
  // Stage the slot into the CPU-side mirror instead of issuing one
  // writeBuffer per tile; the mirror is flushed in a single call at
  // the end of this renderTileKeys invocation.
  vtr.stageUniformSlot(out.slotOffset, vtr.frameBlock.buffer)

  // #2042 INC-4b/4c — resolve the split-bind draw for this tile ONCE, at
  // tile-loop scope: the fill draw consumes it below, and the stroke
  // queue records its tileOff so the deferred stroke pass can bind the
  // same three-range group. Default flat/stroke only (not extrude /
  // overdraw), unclipped, arena-resident copy. The span-copy write path
  // lifts the show/frame lanes from the live legacy frameBlock bytes
  // (byte-parity by construction); deliberately NOT gated on the bundle
  // skip flags: replayed bundles read these buffers, so the per-frame
  // content refresh must run whether or not new commands are recorded.
  if (
    vtr._fillRhi?.split &&
    vtr._splitBind &&
    visibleKey < 0 &&
    ctx.sliceLayer !== '' &&
    !isOverdrawActive(vtr.rhi.caps)
  ) {
    const tileOff = vtr._tileUniforms.offsetOf(ctx.sliceLayer, key, worldOff)
    if (tileOff >= 0) {
      const showOff = vtr._splitBind.syncShow(
        vtr.frameBlock.buffer,
        ctx.sliceLayer,
        vtr.currentPickId & 0xffff,
        vtr.currentFrameId,
      )
      vtr._splitBind.syncFrame(vtr.frameBlock.buffer, vtr.currentFrameId)
      const bg = vtr._splitBind.bindGroup()
      if (bg) out.splitBind = { bg, tileOff, showOff }
    }
  }
  // The show/frame lanes are now seeded for this call — later
  // arena-resident tiles may take the walk-skip.
  out.packedOnce = true
}
