// ═══ Vector drape baked-texture cache policy (#599 I3) ═══
//
// The pure eviction policy for VectorDrapeRenderer's baked-fill cache, split out
// (zero GPU/render imports) so the LRU-cap behaviour is unit-testable without
// standing up the RasterDraper / WebGPU stack. VectorDrapeRenderer owns the Map
// and the destroyTexture side effects; this module only DECIDES which keys go.

/** Plan baked-texture cache evictions: the least-recently-draped entries (lowest
 *  lastCall) that are NOT currently visible, dropped until the cache is back
 *  within `cap`. Mirrors raster-renderer.evictTiles — skip the visible set, drop
 *  the LRU tail past the cap. Returns the cache keys to destroyTexture + delete
 *  (empty when at/under the cap, or when every over-cap entry is still visible —
 *  an on-screen bake is never evicted, which keeps a static globe rebake-free). */
export function planBakeEvictions(
  baked: ReadonlyMap<string, { readonly lastCall: number }>,
  visibleKeys: ReadonlySet<string>,
  cap: number,
): string[] {
  if (baked.size <= cap) return []
  const evictable: Array<[string, number]> = []
  for (const [k, e] of baked) if (!visibleKeys.has(k)) evictable.push([k, e.lastCall])
  evictable.sort((a, b) => a[1] - b[1])
  const n = Math.min(baked.size - cap, evictable.length)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(evictable[i]![0])
  return out
}

// ═══ #1222 — zoom-bucketed stroke rebake ═══
//
// The stroke bake rasterises a screen-px width at a fixed bakeMpp, which is
// only correct where one bake texel ≈ one screen px (camZoom == tileZoom). As
// the camera zooms within a tile level the magnified texture scales the stroke
// with it. Quantising (camZoom − tileZoom) into quarter-zoom buckets and
// scaling the baked width by 2^(−bucket/4) holds the on-screen width within
// ±2^(1/8) ≈ ±9 % of the style contract, at the cost of one rebake per bucket
// step per visible tile (the existing bake cache bounds the churn; the entry
// is REPLACED, so VRAM never grows). Fills are area-styled — magnification is
// benign — so fill-only tiles never take the bucket (see renderGlobeFills).

/** Clamp bound for the bucket: ±8 quarter-steps = ±2 zoom of over/under-zoom.
 *  Beyond that (deep parent-tile fallback, transient) the width degrades
 *  gracefully instead of thrashing sub-texel rebakes. */
const DRAPE_ZOOM_BUCKET_MAX = 8

/** Quarter-zoom bucket of the camera's continuous zoom relative to the tile's
 *  own z. 0 at camZoom == tileZoom (the bake-native anchor). */
export function drapeZoomBucket(camZoom: number, tileZoom: number): number {
  const b = Math.round((camZoom - tileZoom) * 4)
  return Math.max(-DRAPE_ZOOM_BUCKET_MAX, Math.min(DRAPE_ZOOM_BUCKET_MAX, b))
}

/** Width multiplier that cancels the bucket's texture magnification: the tile
 *  texture is magnified 2^(camZoom − tileZoom) on screen, so the baked width
 *  shrinks by the same factor to keep the screen-px contract. */
export function drapeStrokeWidthScale(bucket: number): number {
  return Math.pow(2, -bucket / 4)
}

/** The `dpr` the BAKE's line layer must carry so its antialias band lands at the
 *  same width on screen as the direct path's (#2346).
 *
 *  #1222 above compensates the stroke's CORE width and stops there. The painted
 *  edge is wider than the core by the fragment's AA half-band, `0.5 / dpr` in
 *  LAYER pixels (shaders/dsl/line.ts) — and in a bake one layer pixel is one
 *  BAKE TEXEL, which the sphere magnifies by the very factor #1222 just divided
 *  out of the core. Writing `dpr = 1` there (as the bake did) therefore paints a
 *  band of `0.5 · 2^(camZoom − tileZoom) · dpr` device px against the direct
 *  path's flat 0.5 — measured on OFM Positron at dpr 2, z7.5: road runs of 7.0
 *  device px against the Mercator control's 3.0, i.e. roads 2.3× too thick, the
 *  defect no pixel-diff or sharpness scalar names.
 *
 *  One bake texel spans `1 / widthScale` CSS px on screen (that IS the quantised
 *  magnification #1222 measured), so `dpr · 2^(camZoom − tileZoom) = dpr /
 *  widthScale` makes `0.5 / dpr_uniform` bake texels land as 0.5 device px —
 *  the direct path's band exactly. At `widthScale = 1` (bake-native zoom) and
 *  `dpr = 1` this is 1, the value the bake used to hard-code, so the
 *  bake-native dpr-1 frame is byte-identical. */
export function bakeStrokeAaDpr(dpr: number, widthScale: number): number {
  return Math.max(1e-3, dpr) / Math.max(1e-6, widthScale)
}
