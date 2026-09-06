import type { VectorTileRenderer, RenderFrameState } from '../vector-tile-renderer'
import type { RenderArgs } from '../vector-tile-renderer-types'
import { computeDrapeOverzoom } from '../drape-overzoom-dispatch'
import { drapesAtChordBudget } from '../globe-drape-budget'
import { VectorDrapeRenderer } from '../vector-drape-renderer'
import { strokeBakeKey } from '../vector-drape-stroke'
import { getSampleCount } from '@xgis/engine'
import { bakesVectorDrape, drapesStrokesAtSelectionZ } from '@xgis/geo'

/** #2508 phase 6 — decide the drape routing for this layer on the curved
 *  projections: whether a bake is available at all (a capability, #2474),
 *  whether the fills and — separately — the strokes drape or draw direct
 *  (the #2094 pixel budget against the held / target LOD), and the globe
 *  virtual overzoom dispatch past the source's maxLevel (#2024). Writes the
 *  drape fields the draw phases read (`_drapeGlobeFills`, `_drapeStrokes`,
 *  `_bakeStrokesGated`, `_bakeDpr`, `_drape`); reads no later state. */
export function resolveDrapeRouting(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  ctx: RenderFrameState,
): void {
  // #599 I2 — globe/sphere vector great-circle drape. On a curved-surface route a
  // flat fill triangle spanning a big arc projects as a CHORD under the sphere, so
  // instead each resident tile's fill bakes to a texture (I1) and drapes onto the
  // raster sphere grid (VectorDrapeRenderer) to hug the curve. `bakesVectorDrape`
  // gates it to the {3,4,5}∪globeMode surface — oblique(6) is cylindrical/flat-MVP
  // at all pitches so it is EXCLUDED (renders direct). `drapesAtChordBudget` adds
  // the #2094 PIXEL BUDGET: the trade reverses once the tiles are fine enough FOR
  // THIS CAMERA, so anything a source can serve renders direct. Needs an out-of-frame
  // pass + NON-extruded + CONSTANT fill; `__XGIS_DISABLE_VECTOR_DRAPE` draws direct.
  vtr._bakeDpr = args.dpr
  // Whether a bake is AVAILABLE at all, as opposed to whether it WINS: the bake
  // records an offscreen pass on an out-of-frame encoder — a CAPABILITY (#2474).
  const bakeAvailable =
    vtr.rhi.caps.outOfFramePasses &&
    vtr.currentExtrudeMode === 'none' &&
    (globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }).__XGIS_DISABLE_VECTOR_DRAPE !== true
  // Design INC-3 — the STROKE half of the drape decision, taken next to the fill
  // half rather than inside it. Same escape hatches (the force flag holds the
  // drape for A/B arms; the disable flag forces every direct draw), same
  // bake availability and same held-vs-camera LOD reading.
  vtr._bakeStrokesGated =
    vtr._bakeStrokeActive &&
    bakesVectorDrape(args.projType, args.camera.globeMode) &&
    (drapesStrokesAtSelectionZ(Math.max(ctx.currentZ, ctx.targetZ)) ||
      (globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE === true) &&
    bakeAvailable
  vtr._drapeGlobeFills =
    bakesVectorDrape(args.projType, args.camera.globeMode) &&
    // #2094 — PIXEL BUDGET, not a LOD ceiling: the drape wins only where the direct
    // arm's chord error exceeds the bake's own resample cost, i.e. where the camera
    // has run past what the source can supply. Read off the drawn LOD OR the camera's
    // (`targetZ`): in a zoom-in readiness hold currentZ trails the camera and the held
    // tiles must draw direct (_globe-direct-hold-window-gate). FORCE holds the drape.
    (drapesAtChordBudget(Math.max(ctx.currentZ, ctx.targetZ), args.camera.zoom) ||
      (globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE === true) &&
    bakeAvailable &&
    // The I1 bake is the DEFAULT fill pipeline (single `fill_color`), so it
    // reproduces a constant / zoom-interp fill but NOT a per-feature (feature-
    // buffer) fill or a sprite pattern — those keep the direct draw.
    !args.show.shaderVariant?.needsFeatureBuffer &&
    args.show.fillPatternUV == null
  if (
    vtr._drapeGlobeFills &&
    args.phase !== 'strokes' &&
    args.phase !== 'oit-fill' &&
    // Run the drape when there is a FILL to bake OR a stroke to bake (#599 line-drape). A line-only
    // show — a coastline / road layer — has `_skipFillDraw` (no fill geometry) but still drapes its
    // strokes; the fill bake self-skips the empty interior and the stroke bake curves the line.
    (!vtr._skipFillDraw || vtr._bakeStrokesGated)
  ) {
    vtr._drape ??= new VectorDrapeRenderer(vtr.rhi, vtr.format, getSampleCount())
    // #599 line-drape — a baked stroke is drawn by the sphere grid, so the direct
    // ECEF-chord draw for this show is suppressed (see `drawStrokes` in renderTileKeys).
    // Design INC-3: the stroke ceiling is its OWN number, so a frame can drape its
    // fills and still draw its roads direct — see GLOBE_DIRECT_MIN_STROKE_Z.
    vtr._drapeStrokes = vtr._bakeStrokesGated
    // #2024 — globe virtual overzoom: past the source maxLevel, drape sharp
    // windowed sub-tile bakes instead of the 2^(zoom − maxLevel)×-magnified
    // parent bake (mechanism + atomic-switch rules: drape-overzoom-dispatch).
    const drapeOverzoom = computeDrapeOverzoom({
      camera: args.camera,
      projType: args.projType,
      currentZ: ctx.currentZ,
      cssWidth: args.canvasWidth / args.dpr,
      cssHeight: args.canvasHeight / args.dpr,
      dpr: args.dpr,
      diag: vtr._sliceOverzoomDiag(ctx.sliceLayer),
      source: ctx.source,
      sliceLayer: ctx.sliceLayer,
      neededKeys: ctx.neededKeys,
      layerCache: vtr.getOrCreateLayerCache(ctx.sliceLayer),
      uploadResident: (parentKey) =>
        vtr.uploadTile(
          parentKey,
          ctx.source!.getTileData(parentKey, ctx.sliceLayer)!,
          ctx.sliceLayer,
        ),
    })
    vtr._drape.renderGlobeFills(
      args.rhiPass,
      ctx.frame,
      args.projType,
      args.projCenterLon,
      args.projCenterLat,
      args.camera,
      vtr.currentOpacity ?? 1,
      vtr.cachedFillColor as [number, number, number, number],
      strokeBakeKey(vtr._bakeStrokesGated, vtr._bakeStroke),
      args.camera.zoom,
      ctx.sliceLayer,
      ctx.neededKeys,
      ctx.worldOffDeg,
      vtr.getOrCreateLayerCache(ctx.sliceLayer),
      vtr,
      drapeOverzoom,
      [vtr.currentFillTranslateNdcX, vtr.currentFillTranslateNdcY], // #2249
    )
  }
}
