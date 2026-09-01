// ═══ #2024 — globe drape virtual-overzoom dispatch ═══
//
// Past the source maxLevel the tile selection clamps currentZ, so the drape
// would magnify each 512px tile bake 2^(zoom − maxLevel)× — the "globe goes
// low-res past the source max" report; the direct path never blurs because it
// re-projects real vertices. This module selects VIRTUAL sub-tiles at the
// camera's own z from the SAME globe selector tile selection uses, maps each
// onto its resident maxLevel ancestor, and hands VectorDrapeRenderer the
// windowed set. Extracted from vector-tile-renderer's render loop (#1003 LOC
// ceiling) — pure with respect to VTR state: every collaborator arrives as an
// argument, so the residency/empty/missing ladder is unit-testable.

import { tileKey } from '@xgis/compiler'
import { globeVisibleTiles } from '@xgis/data'
import { isGlobeProj } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import type { DrapeOverzoomTile } from './vector-drape-renderer'

/** Deepest virtual overzoom depth the globe drape windows past the source
 *  maxLevel. 8 covers the whole camera range (universal maxZoom 22 over the
 *  shallowest real-world archive maxLevels) while bounding the per-frame
 *  virtual selector call. */
const DRAPE_OVERZOOM_MAX_BOOST = 8

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
  source: DrapeOverzoomSource
  sliceLayer: string
  layerCache: { has(key: number): boolean }
  /** Upload a catalog-resident ancestor the primary selection never touched. */
  uploadResident(parentKey: number): void
}): DrapeOverzoomTile[] | undefined {
  const { camera, source } = a
  const srcMaxLevel = source.maxLevel
  let virtualZ = Math.min(Math.floor(camera.zoom), srcMaxLevel + DRAPE_OVERZOOM_MAX_BOOST)
  // globeVisibleTiles serves deep zoom through its overzoom FOOTPRINT branch,
  // gated on zoom > maxZ + 1e-3; at zoom == maxZ exactly the legacy descent
  // runs instead and collapses past z≈15 (its own in-file comment). At an
  // exact-integer camera zoom drop one virtual level so the footprint branch
  // always serves the set — a transient 2× magnification at the precise
  // integer, against the parent path's 2^(zoom − maxLevel)×.
  if (!(camera.zoom > virtualZ + 1e-3)) virtualZ -= 1
  if (
    !isGlobeProj(a.projType) ||
    srcMaxLevel <= 0 ||
    a.currentZ !== srcMaxLevel ||
    virtualZ <= a.currentZ
  ) {
    return undefined
  }
  const sphereR = activeBody().sphereR
  // Globe stores the TRUE centre latitude (representsCenterAs(7) === 'lat-deg');
  // lon derives from Mercator-X — globeVisibleTiles wraps the ±180.000…3
  // antimeridian float artifact at entry (#2023).
  const vTiles = globeVisibleTiles(
    (camera.centerX / sphereR) * (180 / Math.PI),
    camera.centerLatDeg,
    camera.zoom,
    virtualZ,
    a.cssWidth,
    a.cssHeight,
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
  for (const t of vTiles) {
    const shift = t.z - srcMaxLevel
    if (shift <= 0) {
      allResident = false
      break
    }
    const parentKey = tileKey(srcMaxLevel, t.x >> shift, t.y >> shift)
    if (!a.layerCache.has(parentKey)) {
      if (source.hasTileData(parentKey, a.sliceLayer)) {
        // Compiled in the catalog but never GPU-uploaded (outside the primary
        // selection) — upload directly, same call the visible path uses for
        // its post-compile stragglers.
        allResident = false
        a.uploadResident(parentKey)
      } else if (source.hasTileData(parentKey)) {
        // Fetched/compiled, but EMPTY for this layer (open sea under a land
        // layer): a virtual tile over it has nothing to drape — satisfied by
        // omission, never a reason to hold the sharp path.
      } else {
        allResident = false
        missingParents.push(parentKey)
      }
      continue
    }
    out.push({ z: t.z, x: t.x, y: t.y, parentKey })
  }
  // Fetch/compile the not-yet-cataloged ancestors (per-key dedupe in the
  // catalog makes the per-frame repeat cheap); the switch stays atomic — the
  // parent-magnified path renders until every ancestor is resident.
  if (missingParents.length > 0) source.requestTiles(missingParents)
  return allResident ? out : undefined
}
