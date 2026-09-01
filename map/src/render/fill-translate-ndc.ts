// ═══ fill-translate → NDC: the single producer both backends pack (#2240) ═══
//
// Slots 46/47 (`fill_translate_x/y`) are read by TWO vertex shaders: the polygon
// VS applies the offset to the fill, and the LINE VS applies the same offset to
// a fill's OUTLINE so the two stay glued together (shaders/dsl/line.ts:1449-1462
// — "a fill's outline draws through the line pipeline sharing the fill's per-tile
// slot"). Three call sites pack those slots, and before this file each derived
// the value on its own: `render()` computed it, while the WebGL2 arms
// (`renderFillsRhi` / `renderLinesRhi`) wrote the literal 0. So an authored
// `fill-translate` moved the fill on WebGPU and was silently dropped on WebGL2
// — measured cross-backend on `fixture_fill_translate` as a 60-px-wide diff band
// matching the authored offset exactly.
//
// One producer, so every packer inherits the value by construction rather than
// by three sites agreeing (CLAUDE.md §12, the #2165 shape: a witness applied at
// a packer dies the day a new packer is added).

import type { Camera } from '../camera'
import type { ResolvedShow } from './resolved-show'
import type { ShowCommand } from './renderer-types'

/** Mapbox `*-translate-anchor`: an absent/false flag returns the [dx,dy]
 *  CSS-px offset unchanged (screen-space); map rotates it by the map bearing
 *  so it tracks the MAP world axes (MapLibre map-anchor). Pure 2D rotation;
 *  no allocation when the offset is zero or the anchor is viewport.
 *
 *  `anchorMap` absent is NOT the Mapbox default — the spec's default is `map`,
 *  and the converter supplies it (`addTranslateAnchor`, #2170): a Mapbox style
 *  that omits the anchor arrives here with the flag already set. Absent means
 *  an .xgis layer that did not write the utility. */
export function rotateTranslateForAnchor(
  dx: number,
  dy: number,
  anchorMap: boolean | undefined,
  bearingDeg: number,
): [number, number] {
  if (!anchorMap || (dx === 0 && dy === 0)) return [dx, dy]
  const r = (bearingDeg * Math.PI) / 180
  const c = Math.cos(r),
    s = Math.sin(r)
  return [dx * c - dy * s, dx * s + dy * c]
}

/** The (x, y) NDC-per-CSS-pixel pair for slots 46/47.
 *
 *  `translate-anchor: map` rotates the authored offset by the camera bearing so
 *  it tracks the MAP world axes; viewport returns it untouched.
 *  The `!== 0` guards keep an unauthored offset at exactly +0 rather than a
 *  signed zero from the division, so an untranslated show packs byte-identically
 *  to what it always has. */
export function fillTranslateNdc(
  resolvedShow: Pick<ResolvedShow, 'fillTranslateX' | 'fillTranslateY'>,
  show: Pick<ShowCommand, 'fillTranslateAnchorMap'>,
  camera: Pick<Camera, 'bearing'>,
  canvasWidth: number,
  canvasHeight: number,
): readonly [number, number] {
  const [ftx, fty] = rotateTranslateForAnchor(
    resolvedShow.fillTranslateX,
    resolvedShow.fillTranslateY,
    show.fillTranslateAnchorMap,
    camera.bearing ?? 0,
  )
  return [ftx !== 0 ? (ftx * 2) / canvasWidth : 0, fty !== 0 ? (fty * 2) / canvasHeight : 0]
}
