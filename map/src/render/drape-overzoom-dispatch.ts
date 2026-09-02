// ═══ #2024 — globe drape virtual-overzoom dispatch (density rule, #2346) ═══
//
// The drape rasterises each tile into a fixed 512px bake and samples it onto the
// sphere. Wherever one bake texel has to cover more than one DEVICE pixel that
// bake is an upscale — the blur the direct path never has, because it re-projects
// real vertices. This module removes the upscale the way #2024 established:
// select VIRTUAL sub-tiles from the SAME globe selector tile selection uses, map
// each onto a resident ancestor, and hand VectorDrapeRenderer the windowed set —
// each sub-tile its own full-resolution 512px bake of a sub-rect of the parent's
// geometry. Constant texel density at constant per-entry memory.
//
// #2346 — THE TRIGGER IS THE DENSITY, NOT THE SOURCE MAXIMUM. #2024 shipped this
// gated on `currentZ === source.maxLevel`, with no `dpr` input and a floor()'d
// camera zoom, so it engaged ONLY past the source's deepest level. Everything
// inside the source range kept the magnified bake: at dpr 2 a tile spanning
// TILE_PX CSS px covers 2·TILE_PX device px, so the bake is a 2× upscale AT
// NATIVE ZOOM, and a fractional camera zoom adds up to 2× more. Measured on OFM
// Positron at dpr 2 (SwiftShader): the draped frame differed from the same page
// rendering direct by 19.26 % of pixels at z7.5 and 20.21 % at z8.6, every road
// a 5-6 device-px band where the direct arm draws the style's own 1-px casing.
// The mechanism was right; the question it asked was not. It now works in DEVICE
// pixels throughout and engages whenever a deeper virtual level exists.
//
// Extracted from vector-tile-renderer's render loop (#1003 LOC ceiling) — pure
// with respect to VTR state: every collaborator arrives as an argument, so the
// residency/empty/missing ladder is unit-testable.

import { tileKey } from '@xgis/compiler'
import { globeVisibleTiles } from '@xgis/data'
import { isGlobeProj } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import type { DrapeOverzoomTile } from './vector-drape-renderer'

/** Deepest virtual overzoom depth the globe drape windows past the ancestor it
 *  bakes from. 8 covers the whole camera range (universal maxZoom 22 over the
 *  shallowest real-world archive maxLevels) while bounding the per-frame
 *  virtual selector call. */
const DRAPE_OVERZOOM_MAX_BOOST = 8

/** Why `computeDrapeOverzoom` returned what it returned, for the frame's
 *  diagnostics. Every early return sets `reason`; the engaged path reports the
 *  level and the tile counts it produced. */
export interface DrapeOverzoomDiag {
  reason?: string
  virtualZ?: number
  currentZ?: number
  deviceZoom?: number
  selected?: number
  emitted?: number
  missingParents?: number
  uploadedParents?: number
  split?: boolean
  /** Virtual tiles skipped because the windowed ancestor carries no geometry for
   *  THIS slice (open sea under a land layer). Legitimate — satisfied by
   *  omission — but indistinguishable from a mapping bug without the count. */
  omittedEmpty?: number
  /** The first tile that produced nothing, and what each test said about it.
   *  The whole set going quiet is either "this layer is empty here" or a broken
   *  ancestor mapping, and only the per-test answers separate them. */
  sample?: {
    z: number
    x: number
    y: number
    parentZ: number
    neededHit: boolean
    cacheHit: boolean
    hasSlice: boolean
    hasAny: boolean
  }
}

export interface DrapeOverzoomSource {
  readonly maxLevel: number
  hasTileData(key: number, sourceLayer?: string): boolean
  requestTiles(keys: number[]): void
}

/** Compute the virtual overzoom set for one drape-eligible show, or undefined
 *  while the sharp path must not engage (not overzoomed, not the globe route,
 *  or an ancestor still missing — the parent→virtual switch is atomic per
 *  frame: parent and child cover are never mixed, double alpha cover would
 *  darken translucent fills). Side effects on the miss path only: GPU-uploads
 *  an ancestor the catalog already holds, and requests the ones it doesn't.
 *
 *  Globe route only: the virtual set must come from the selector that owns
 *  globe visibility; the flat-disc drape trio (3/4/5) selects via SSE and
 *  keeps the parent-magnified behaviour for now (follow-up noted on #2024). */
export function computeDrapeOverzoom(a: {
  camera: {
    zoom: number
    centerX: number
    centerLatDeg: number
    pitch?: number
    bearing?: number
  }
  projType: number
  /** The selection's resolved LOD — maxLevel-clamped at overzoom. */
  currentZ: number
  cssWidth: number
  cssHeight: number
  /** Device pixel ratio. The bake's texel budget is in DEVICE pixels, so the
   *  whole selection below runs at `zoom + log2(dpr)` over a device-pixel
   *  viewport — the same camera, measured in the pixels the bake competes with
   *  (#2346). 1 leaves every number byte-identical to the CSS-px form. */
  dpr: number
  source: DrapeOverzoomSource
  sliceLayer: string
  /** The primary selection's drawn keys for this show — the ONLY levels whose
   *  geometry is guaranteed on the GPU this frame. A virtual tile windows the
   *  drawn tile that contains it, so the windowed set draws exactly the same
   *  content as the primary path would, only at more texels (#2346). At
   *  over-zoom these are the maxLevel keys, which is the #2024 behaviour
   *  verbatim. */
  neededKeys: readonly number[]
  layerCache: { has(key: number): boolean }
  /** Optional caller-owned scratch the dispatch fills with WHY it did what it
   *  did. The switch is atomic — one unresolved ancestor keeps the whole frame
   *  on the parent path — so "it silently did nothing" is its most common
   *  outcome and was, measured, unreadable from the page: a diagnostic nothing
   *  can reach is not a diagnostic (CLAUDE.md §12). */
  diag?: DrapeOverzoomDiag
  /** Upload a catalog-resident ancestor the primary selection never touched. */
  uploadResident(parentKey: number): void
}): DrapeOverzoomTile[] | undefined {
  const { camera, source } = a
  const srcMaxLevel = source.maxLevel
  // The camera expressed in DEVICE pixels: same field of view, one octave of
  // zoom per doubling of dpr. Selecting at this zoom over a device-pixel
  // viewport is what makes the virtual level a texel-density decision instead
  // of a CSS-pixel one (#2346).
  const dpr = Math.max(1, a.dpr)
  const deviceZoom = camera.zoom + Math.log2(dpr)
  // FLOOR here, then round to nearest with a local split below. The selector's
  // overzoom FOOTPRINT branch — the only one that enumerates a viewport-covering
  // set at a UNIFORM level, with the horizon's foreshortening already priced in —
  // is gated on `zoom > maxZ + 1e-3`, so it can only serve a level strictly BELOW
  // the device zoom. Asking it for `ceil` drops into the legacy descent, which
  // returns a MIXED set (mostly the drawn level, the focal column one deeper) and
  // takes the whole switch down: measured, every in-range case bailed.
  let virtualZ = Math.min(Math.floor(deviceZoom), srcMaxLevel + DRAPE_OVERZOOM_MAX_BOOST)
  if (!(deviceZoom > virtualZ + 1e-3)) virtualZ -= 1
  // #2346: the trigger is "is there a deeper virtual level to bake at", NOT
  // "are we past the source maximum". `virtualZ > currentZ` is exactly the
  // condition under which the windowed set carries more texels than the
  // primary bake would; below it the primary bake is already at or above
  // device density and windowing would only cost draw calls.
  const diag = a.diag
  if (diag) {
    diag.deviceZoom = deviceZoom
    diag.virtualZ = virtualZ
    diag.currentZ = a.currentZ
  }
  if (!isGlobeProj(a.projType) || srcMaxLevel <= 0 || virtualZ <= a.currentZ) {
    if (diag)
      diag.reason = !isGlobeProj(a.projType)
        ? 'not-globe'
        : srcMaxLevel <= 0
          ? 'no-levels'
          : 'no-deeper-level'
    return undefined
  }
  const sphereR = activeBody().sphereR
  // Globe stores the TRUE centre latitude (representsCenterAs(7) === 'lat-deg');
  // lon derives from Mercator-X — globeVisibleTiles wraps the ±180.000…3
  // antimeridian float artifact at entry (#2023).
  const vTiles = globeVisibleTiles(
    (camera.centerX / sphereR) * (180 / Math.PI),
    camera.centerLatDeg,
    deviceZoom,
    virtualZ,
    a.cssWidth * dpr,
    a.cssHeight * dpr,
    camera.pitch ?? 0,
    camera.bearing ?? 0,
  )
  let allResident = vTiles.length > 0
  const out: DrapeOverzoomTile[] = []
  // Ancestors the virtual set needs but the GPU cache lacks. The virtual
  // footprint is PADDED (±1 tile at the virtual z), so its edge tiles can map
  // to maxLevel ancestors OUTSIDE the primary selection's own padded box —
  // tiles the normal fetch/upload pipeline never touches. Without requesting
  // them here, one forever-missing pad ancestor pins allResident false and the
  // sharp path never engages.
  const missingParents: number[] = []
  let uploadedParents = 0
  let omittedEmpty = 0
  // The tile to window is the one the PRIMARY selection is drawing over this
  // virtual tile — not `srcMaxLevel`. Inside the source range the selection
  // draws at `currentZ` (coarser on the horizon), so maxLevel tiles are not
  // loaded at all: keying on them would miss every cache hit AND fetch the
  // deepest archive level at a continental zoom (#2346). At over-zoom
  // `neededKeys` IS the maxLevel set, so this reduces to #2024's own mapping.
  // `deepestAncestorZ` stays the fetch target for a virtual tile the primary
  // box does not cover (the ±1-tile virtual pad), which is what the ladder
  // below requests.
  const needed = new Set(a.neededKeys)
  const deepestAncestorZ = Math.min(virtualZ - 1, srcMaxLevel)
  for (const t of vTiles) {
    let parentKey = -1
    let drawnKey = -1
    for (let az = Math.min(deepestAncestorZ, t.z - 1); az >= 0; az--) {
      const shift = t.z - az
      const k = tileKey(az, t.x >> shift, t.y >> shift)
      // The deepest candidate is the fetch target; the drawn ancestor is the
      // first one the primary selection actually put on screen.
      if (parentKey < 0) parentKey = k
      if (needed.has(k) && a.layerCache.has(k)) {
        drawnKey = k
        break
      }
    }
    if (parentKey < 0) {
      allResident = false
      break
    }
    if (drawnKey < 0) {
      if (a.layerCache.has(parentKey)) {
        // Resident but outside the primary draw set (a pad tile from an earlier
        // frame): window it — same content, more texels, no fetch.
        out.push({ z: t.z, x: t.x, y: t.y, parentKey })
        continue
      }
      if (diag && !diag.sample) {
        const [pz] = [Math.min(deepestAncestorZ, t.z - 1)]
        diag.sample = {
          z: t.z,
          x: t.x,
          y: t.y,
          parentZ: pz,
          neededHit: needed.has(parentKey),
          cacheHit: a.layerCache.has(parentKey),
          hasSlice: source.hasTileData(parentKey, a.sliceLayer),
          hasAny: source.hasTileData(parentKey),
        }
      }
      if (source.hasTileData(parentKey, a.sliceLayer)) {
        // Compiled in the catalog but never GPU-uploaded (outside the primary
        // selection) — upload directly, same call the visible path uses for
        // its post-compile stragglers.
        allResident = false
        uploadedParents++
        a.uploadResident(parentKey)
      } else if (source.hasTileData(parentKey)) {
        omittedEmpty++
        // Fetched/compiled, but EMPTY for this layer (open sea under a land
        // layer): a virtual tile over it has nothing to drape — satisfied by
        // omission, never a reason to hold the sharp path.
      } else {
        allResident = false
        missingParents.push(parentKey)
      }
      continue
    }
    out.push({ z: t.z, x: t.x, y: t.y, parentKey: drawnKey })
  }
  // Fetch/compile the not-yet-cataloged ancestors (per-key dedupe in the
  // catalog makes the per-frame repeat cheap); the switch stays atomic — the
  // parent-magnified path renders until every ancestor is resident.
  if (missingParents.length > 0) source.requestTiles(missingParents)
  if (diag) {
    diag.selected = vTiles.length
    diag.emitted = out.length
    diag.missingParents = missingParents.length
    diag.uploadedParents = uploadedParents
    diag.omittedEmpty = omittedEmpty
  }
  if (!allResident) {
    if (diag) diag.reason = vTiles.length === 0 ? 'selector-empty' : 'ancestor-not-resident'
    return undefined
  }
  // ROUND TO NEAREST, not down. `virtualZ` is the floor of the device zoom, so a
  // fractional camera leaves each virtual tile covering 2^(deviceZoom − virtualZ)
  // ∈ [1, 2) device pixels per bake texel — at dpr 2 / z7.5 (deviceZoom 8.5) a
  // 1.41× upscale, measured as a still-soft, still-thick stroke against the
  // Mercator control after the AA band was corrected. Past the half-octave, split
  // each tile once IN PLACE: the set is already viewport-covering at a uniform
  // level, so the 4-way split neither re-runs selection nor over-subdivides the
  // foreshortened horizon (which is why this is not applied to the drawn set
  // directly). Bounded at ×4 entries, and it turns the worst case from a 2×
  // undershoot into a 1.41× overshoot — the side of the trade a baked tile that
  // must look like the direct render wants to be on.
  if (deviceZoom - virtualZ < 0.5) {
    if (diag) {
      diag.reason = 'engaged'
      diag.split = false
    }
    return out
  }
  const split: DrapeOverzoomTile[] = []
  for (const t of out) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        split.push({ z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy, parentKey: t.parentKey })
      }
    }
  }
  if (diag) {
    diag.reason = 'engaged'
    diag.split = true
    diag.emitted = split.length
  }
  return split
}
