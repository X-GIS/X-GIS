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
// FLAT projections (projType 1 equirectangular, 2 natural_earth) share the
// SAME Mercator RTC MVP as mercator: the engine pre-reprojects each vertex by
// a flat project_geom(lonlat, projType) before the shared MVP consumes it
// (runtime/src/engine/shader-dsl/shaders/projections.ts). So X-GIS screen =
// MVP_merc · (project_geom(ll) − project_geom(center), 0, 1). The d3 recipes
// below are PROBE-VERIFIED bit-exact (maxErr ~6e-6 px vs the live GPU MVP):
//   • equirectangular — STOCK geoEquirectangular aligns to FP-zero.
//   • natural_earth   — STOCK geoNaturalEarth1 does NOT align (d3's x-poly
//     differs from X-GIS's); a CUSTOM raw built from X-GIS's exact polynomial
//     (xgisNaturalEarth1Raw, below) aligns to FP-zero.
// Both use the same .scale(256/π·2^z) (px-per-radian == the mercator scaleA).
//
// The remaining non-flat branches (orthographic/azimuthal/stereographic/
// oblique) are STILL stubbed (3D ECEF MVP, not probe-verified) — calling them
// throws so a caller can't silently trust an unverified reference.

import {
  geoMercator,
  geoEquirectangular,
  geoNaturalEarth1,
  geoOrthographic,
  geoAzimuthalEquidistant,
  geoStereographic,
  geoTransverseMercator,
  geoProjection,
  type GeoProjection,
} from 'd3-geo'

// X-GIS's EXACT Natural Earth I x/y polynomial (proj_natural_earth_d,
// runtime/.../projections.ts L79-91). d3's stock geoNaturalEarth1 uses a
// different x-scale polynomial (sign-flipped φ⁴ term + 10th/12th-order terms
// vs X-GIS's φ⁶ truncation), so it does NOT align (best ~1.5 px). This raw
// receives λ/φ in RADIANS and returns radians; geoProjection's .scale carries
// radians→px (== scaleA), matching equirectangular. The φ-polynomial here is
// the CPU mirror of the GPU project_geom for projType 2.
function xgisNaturalEarth1Raw(lambda: number, phi: number): [number, number] {
  const phi2 = phi * phi
  const phi4 = phi2 * phi2
  const phi6 = phi2 * phi4
  const xScale = 0.8707 - 0.131979 * phi2 + 0.013791 * phi4 - 0.0081435 * phi6
  const yVal =
    phi * (1.007226 + phi2 * (0.015085 + phi2 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
  return [lambda * xScale, yVal]
}

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
const VERIFIED: ReadonlySet<ProjName> = new Set<ProjName>([
  'mercator',
  'equirectangular',
  'natural_earth',
])

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

  if (!VERIFIED.has(projName)) {
    // Not yet probe-verified (orthographic/azimuthal/stereographic/oblique —
    // 3D ECEF MVP path). Refuse to hand back an unverified reference so a
    // future milestone can't silently diff against the wrong placement.
    throw new Error(
      `xgisCameraToD3: projection "${projName}" d3-reference is not yet ` +
        `probe-verified (Oracle-B covers mercator/equirectangular/natural_earth). ` +
        `Factory is ${factory.name}; calibrate against getECEFFrameView before use.`,
    )
  }

  // All three VERIFIED flat projections share the same scale (256/π·2^z =
  // px-per-radian == the mercator px-per-metre scaleA), the same CSS-px
  // translate, and the same .center([lon,lat]) (the engine's RTC subtraction
  // of project_geom(center) cancels d3's .center() shift exactly). Only the
  // raw projection differs: mercator/equirectangular are stock; natural_earth
  // uses X-GIS's exact polynomial raw (stock geoNaturalEarth1 does NOT align).
  const scale = (256 / Math.PI) * Math.pow(2, zoom)

  if (projName === 'mercator') {
    // The proven, bit-exact recipe.
    return geoMercator()
      .scale(scale)
      .translate([Wcss / 2, Hcss / 2])
      .center([lon, lat])
  }

  if (projName === 'equirectangular') {
    // Probe-verified: STOCK geoEquirectangular aligns to FP-zero (maxErr
    // 6.84e-6 px). Raw is [λ,φ] in radians — same scale as mercator.
    return geoEquirectangular()
      .scale(scale)
      .translate([Wcss / 2, Hcss / 2])
      .center([lon, lat])
  }

  if (projName === 'natural_earth') {
    // Probe-verified: a CUSTOM raw matching X-GIS's exact NE-I polynomial
    // aligns to FP-zero (maxErr 6.37e-6 px); stock geoNaturalEarth1 does not.
    return geoProjection(xgisNaturalEarth1Raw)
      .scale(scale)
      .translate([Wcss / 2, Hcss / 2])
      .center([lon, lat])
  }

  // VERIFIED.has(projName) is true but no branch matched — unreachable while
  // the verified set and the branches above stay in sync.
  throw new Error(`xgisCameraToD3: unhandled verified projection "${projName}".`)
}
