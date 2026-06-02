// xgisCameraToD3 — build the d3-geo projection that reproduces X-GIS's
// on-screen placement for a given camera, so Oracle-B can render an
// independent geometry reference and pixel-diff it against the GPU frame.
//
// MERCATOR RECIPE (PROVEN — probe artifact .rv-probe-artifact.json,
// mean 1.19e-5 px / max 2.08e-5 px over 31 samples vs the live GPU MVP):
//
//   geoMercator()
//     .scale(256 / Math.PI * 2 ** zoom)   // 256/π ⇒ the 512-px-tile world
//     .translate([Wcss / 2, Hcss / 2])    // CSS-px canvas center
//     .center([centerLon, centerLat])     // RTC subtraction cancels exactly
//
// WHY it's exact: X-GIS's mercator forward and d3.geoMercator are the same
// conformal Web-Mercator transform. The engine's mercator vertex space is
// RELATIVE-TO-CENTER metres (clip = MVP · (mercXY − centerMercXY, 0, 1)),
// and d3's .center() applies the identical lon/lat shift, so the two cancel.
// scale = 256/π · 2^z == (WORLD_MERC / TILE_PX) px-per-metre at that zoom.
//
// CSS vs DEVICE px: the camera MVP is built on CSS px (canvasH / dpr); NDC is
// resolution-independent (dpr scales W and H together), so CSS-px is the
// canonical convention and is what d3 must use throughout (scale + translate).
//
// The non-mercator branches (1–7) are STUBBED with the correct d3 factory
// per the projType→d3 table for later milestones. They are configured with a
// best-effort scale/translate/rotate but are NOT yet probe-verified against
// the engine's ECEF MVP path (getECEFFrameView) — calling them throws so a
// caller can't silently trust an unverified reference.

import {
  geoMercator,
  geoEquirectangular,
  geoNaturalEarth1,
  geoOrthographic,
  geoAzimuthalEquidistant,
  geoStereographic,
  geoTransverseMercator,
  type GeoProjection,
} from 'd3-geo'

/** X-GIS setProjection names → projType index (gpu-shared PROJECTIONS order). */
export type ProjName =
  | 'mercator'
  | 'equirectangular'
  | 'natural_earth'
  | 'orthographic'
  | 'azimuthal_equidistant'
  | 'stereographic'
  | 'oblique_mercator'
  | 'globe'

/** projName → the d3-geo factory that matches it (table from the spec). */
export const D3_PROJECTION_FACTORY: Record<ProjName, (() => GeoProjection) | null> = {
  mercator: geoMercator,
  equirectangular: geoEquirectangular,
  natural_earth: geoNaturalEarth1,
  orthographic: geoOrthographic,
  azimuthal_equidistant: geoAzimuthalEquidistant,
  stereographic: geoStereographic,
  // oblique_mercator ≈ transverse mercator (closest standard d3 analogue).
  oblique_mercator: geoTransverseMercator,
  // globe is 3D — no flat d3 reference; Oracle-B does not cover it.
  globe: null,
}

/** Projections whose d3 mapping is PROBE-VERIFIED bit-exact vs the GPU MVP. */
const VERIFIED: ReadonlySet<ProjName> = new Set<ProjName>(['mercator'])

/**
 * Build a configured d3-geo projection reproducing X-GIS's on-screen
 * placement for the given camera. Coordinates are CSS px throughout.
 *
 * @param projName  X-GIS projection name.
 * @param center    [lon, lat] degrees (map.getCenter()).
 * @param zoom      map.getZoom().
 * @param Wcss      CSS canvas width  (device width / dpr).
 * @param Hcss      CSS canvas height (device height / dpr).
 */
export function xgisCameraToD3(
  projName: ProjName,
  center: [number, number],
  zoom: number,
  Wcss: number,
  Hcss: number,
): GeoProjection {
  const factory = D3_PROJECTION_FACTORY[projName]
  if (!factory) {
    throw new Error(
      `xgisCameraToD3: no flat d3 reference for projection "${projName}" (globe is 3D).`,
    )
  }

  const [lon, lat] = center

  if (projName === 'mercator') {
    // The proven, bit-exact recipe.
    return geoMercator()
      .scale((256 / Math.PI) * Math.pow(2, zoom))
      .translate([Wcss / 2, Hcss / 2])
      .center([lon, lat])
  }

  if (!VERIFIED.has(projName)) {
    // Stub: configured but NOT probe-verified. Refuse to hand back an
    // unverified reference so a future milestone can't silently diff
    // against the wrong placement. The d3 factory table above is the
    // mapping a later milestone will calibrate (likely vs getECEFFrameView).
    throw new Error(
      `xgisCameraToD3: projection "${projName}" d3-reference is not yet ` +
        `probe-verified (milestone-1 covers mercator only). ` +
        `Factory is ${factory.name}; calibrate against getECEFFrameView before use.`,
    )
  }

  // Unreachable in milestone-1 (only mercator is VERIFIED and handled above).
  return factory()
    .scale((256 / Math.PI) * Math.pow(2, zoom))
    .translate([Wcss / 2, Hcss / 2])
    .rotate([-lon, 0])
    .center([0, lat])
}
