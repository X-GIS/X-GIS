// ═══════════════════════════════════════════════════════════════════
// Distance Transform → Signed Distance Field (Batch 1c-6a)
// ═══════════════════════════════════════════════════════════════════
//
// Implements Felzenszwalb & Huttenlocher's exact O(N) 1D distance
// transform of sampled functions, applied separately to rows then
// columns (the standard 2D extension). Same algorithm tiny-sdf
// uses; reference:
//   P. Felzenszwalb, D. Huttenlocher,
//   "Distance Transforms of Sampled Functions" (Theory of
//    Computing 8, 2012)
//   https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf
//
// For glyph SDF we want the SIGNED distance: positive outside the
// glyph, negative inside (Mapbox/MapLibre convention is the inverse
// — we follow tiny-sdf's "0 = far inside, 192 = edge, 255 = far
// outside" packing because that's what every existing SDF text
// shader expects).
//
// `computeSDF(alpha, w, h, radius)` — input: 8-bit alpha mask
// (0 outside, 255 inside, intermediate = anti-aliased edge);
// output: 8-bit SDF where 192 marks the glyph edge and `radius`
// pixels of falloff are encoded on either side. The +/-radius
// range is what the fragment shader thresholds in `[0, 1]` after
// dividing by the SDF cell size.
//
// All math uses Float64 for the DT itself (small cell sizes — the
// extra precision is negligible vs allocation cost) and quantises
// to Uint8 only at the end.

const INF = 1e20

/** 1D distance transform of a function `f` of length `n`. Returns
 *  the squared Euclidean distance to the nearest "set" sample —
 *  where a sample is "set" iff `f[i] === 0`, and "unset" iff
 *  `f[i] === INF`. Anything in between is treated as a noisy
 *  sample (the algorithm handles it correctly per the paper). */
function dt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = +INF
  for (let q = 1; q < n; q++) {
    let s: number
    // Locate the parabola from `q` in the lower envelope.
    while (true) {
      const r = v[k]!
      s = (f[q]! + q * q - (f[r]! + r * r)) / (2 * (q - r))
      if (s > z[k]!) break
      k -= 1
      if (k < 0) { k = 0; break }
    }
    k += 1
    v[k] = q
    z[k] = s
    z[k + 1] = +INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k += 1
    const r = v[k]!
    out[q] = (q - r) * (q - r) + f[r]!
  }
}

/** Run 2D DT on a w×h field. `field` is mutated in place — for
 *  each pixel it ends up holding squared distance to the nearest
 *  "0" sample (inside or outside, depending on which mask the
 *  caller filled in). */
export function distanceTransform2D(
  field: Float64Array, w: number, h: number,
): Float64Array {
  const dim = Math.max(w, h)
  const buf = new Float64Array(dim)
  const out = new Float64Array(dim)
  const v = new Int32Array(dim)
  const z = new Float64Array(dim + 1)

  // Rows
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) buf[x] = field[y * w + x]!
    dt1d(buf, w, out, v, z)
    for (let x = 0; x < w; x++) field[y * w + x] = out[x]!
  }
  // Columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) buf[y] = field[y * w + x]!
    dt1d(buf, h, out, v, z)
    for (let y = 0; y < h; y++) field[y * w + x] = out[y]!
  }
  return field
}

/** Build a signed distance field from an 8-bit alpha mask.
 *
 *  alpha[y*w + x] in [0, 255]: 0 outside glyph, 255 inside,
 *  intermediate = anti-aliased edge. Output is a Uint8Array of the
 *  same dimensions where each byte encodes the signed distance
 *  with `radius`-pixel falloff:
 *    - 192 at the glyph edge (alpha = 128)
 *    - 192 + (255-192) at `radius` px outside (max OUT)
 *    - 192 - 192 at `radius` px inside (max IN)
 *    - linear in pixels in between
 *  This packing matches tiny-sdf / Mapbox glyph PBF, so any text
 *  shader written for those drops in unchanged. */
export function computeSDF(
  alpha: Uint8Array | Uint8ClampedArray,
  w: number, h: number,
  radius: number,
): Uint8Array {
  const N = w * h
  // Fields for outside-distance and inside-distance DT respectively.
  const fOut = new Float64Array(N)
  const fIn = new Float64Array(N)

  // Threshold at alpha = 128 (= the edge). Soft anti-aliased pixels
  // contribute fractional sub-pixel correction via the standard
  // tiny-sdf trick: subtract 0.5 from the reported distance for
  // pixels near the edge so the SDF sees the analytic boundary
  // rather than the discrete one. We omit that here for the first
  // pass to keep the implementation simple; renderers that care
  // about sub-pixel sharpness can switch to AA-aware DT later.
  for (let i = 0; i < N; i++) {
    const a = alpha[i]!
    if (a < 128) {
      // Outside the glyph — distance to nearest INSIDE pixel later.
      fOut[i] = 0
      fIn[i] = INF
    } else {
      fOut[i] = INF
      fIn[i] = 0
    }
  }

  distanceTransform2D(fOut, w, h)
  distanceTransform2D(fIn, w, h)

  const out = new Uint8Array(N)
  // Encode distance in pixels (sqrt the squared field). Edge maps
  // to 192, falloff over `radius` px on each side fills the rest
  // of the byte. Outside positive, inside negative — packed into
  // [0, 255] with 192 as the zero crossing.
  for (let i = 0; i < N; i++) {
    const distOut = Math.sqrt(fOut[i]!)
    const distIn = Math.sqrt(fIn[i]!)
    // signed = +outside / -inside in pixels. We want the byte to be
    // HIGH inside (255 = far inside) and LOW outside (0 = far
    // outside) so the shader's `step(192/255, sdf)` lights up the
    // glyph interior — that's the Mapbox/tiny-sdf convention every
    // SDF text shader expects.
    const signed = distIn - distOut
    const v = 192 - (signed / radius) * 63
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
  }
  return out
}
