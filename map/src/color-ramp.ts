// ═══ Color Ramp LUT Textures ═══
// Creates 256×1 RGBA textures for data-driven color mapping.
// Usage in WGSL: textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5))

/**
 * Built-in color ramp definitions.
 * Each is an array of [r, g, b] stops (0-255) at evenly spaced positions.
 */
export const RAMPS: Record<string, [number, number, number][]> = {
  // Depth ramp (S-102): shallow (light cyan) → deep (dark navy). Positive-down, so
  // a larger value = deeper = darker. #1158 GAP-1.
  bathymetry: [
    [224, 243, 248],
    [171, 217, 233],
    [116, 173, 209],
    [69, 117, 180],
    [49, 54, 149],
  ],
  viridis: [
    [68, 1, 84],
    [72, 35, 116],
    [64, 67, 135],
    [52, 94, 141],
    [41, 120, 142],
    [32, 144, 140],
    [34, 167, 132],
    [68, 190, 112],
    [121, 209, 81],
    [189, 222, 38],
    [253, 231, 37],
  ],
  hot: [
    [0, 0, 0],
    [128, 0, 0],
    [255, 0, 0],
    [255, 128, 0],
    [255, 255, 0],
    [255, 255, 128],
    [255, 255, 255],
  ],
  blues: [
    [247, 251, 255],
    [222, 235, 247],
    [198, 219, 239],
    [158, 202, 225],
    [107, 174, 214],
    [66, 146, 198],
    [33, 113, 181],
    [8, 81, 156],
    [8, 48, 107],
  ],
  reds: [
    [255, 245, 240],
    [254, 224, 210],
    [252, 187, 161],
    [252, 146, 114],
    [251, 106, 74],
    [239, 59, 44],
    [203, 24, 29],
    [165, 15, 21],
    [103, 0, 13],
  ],
  rdylgn: [
    [165, 0, 38],
    [215, 48, 39],
    [244, 109, 67],
    [253, 174, 97],
    [254, 224, 139],
    [255, 255, 191],
    [217, 239, 139],
    [166, 217, 106],
    [102, 189, 99],
    [26, 152, 80],
    [0, 104, 55],
  ],
  coolwarm: [
    [59, 76, 192],
    [98, 130, 234],
    [141, 176, 254],
    [184, 208, 249],
    [221, 221, 221],
    [245, 196, 173],
    [244, 154, 123],
    [222, 96, 77],
    [180, 4, 38],
  ],
  ocean: [
    [0, 32, 64],
    [0, 48, 96],
    [0, 64, 128],
    [0, 96, 160],
    [0, 128, 192],
    [32, 160, 208],
    [96, 192, 224],
    [160, 224, 240],
    [224, 240, 255],
  ],
  terrain: [
    [0, 64, 0],
    [0, 128, 0],
    [64, 160, 32],
    [128, 192, 64],
    [192, 224, 128],
    [224, 224, 192],
    [160, 128, 96],
    [128, 96, 64],
    [255, 255, 255],
  ],
  plasma: [
    [13, 8, 135],
    [75, 3, 161],
    [125, 3, 168],
    [168, 34, 150],
    [203, 70, 121],
    [229, 107, 93],
    [248, 148, 65],
    [253, 195, 40],
    [240, 249, 33],
  ],
  grayscale: [
    [0, 0, 0],
    [255, 255, 255],
  ],
}

/**
 * Create a 256×1 RGBA texture for a named color ramp.
 */
export function createColorRampTexture(
  device: GPUDevice,
  rampName: string,
  steps = 256,
): GPUTexture | null {
  const banded = BANDED_RAMPS[rampName]
  const stops = RAMPS[rampName]
  if (!banded && !stops) return null

  const data = banded ? interpolateBandedRamp(banded, steps) : interpolateRamp(stops!, steps)

  const texture = device.createTexture({
    size: { width: steps, height: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    label: `ramp-${rampName}`,
  })

  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: steps * 4 },
    { width: steps, height: 1 },
  )

  return texture
}

/**
 * Create a GPU sampler for color ramp lookup.
 */
export function createRampSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    label: 'ramp-sampler',
  })
}

/** List all available ramp names (interpolated + banded). */
export function availableRamps(): string[] {
  return [...Object.keys(RAMPS), ...Object.keys(BANDED_RAMPS)]
}

/**
 * Interpolate a color ramp from sparse stops to a dense pixel array. Exported so
 * the coverage-ramp arm (#1158) can bake a LUT through the RHI seam reusing this
 * stop-interpolation math (NOT createColorRampTexture, which takes a raw GPUDevice).
 */
export function interpolateRamp(stops: [number, number, number][], steps: number): Uint8Array {
  const data = new Uint8Array(steps * 4)

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    const pos = t * (stops.length - 1)
    const idx = Math.floor(pos)
    const frac = pos - idx

    const c0 = stops[Math.min(idx, stops.length - 1)]
    const c1 = stops[Math.min(idx + 1, stops.length - 1)]

    const offset = i * 4
    data[offset + 0] = Math.round(c0[0] + (c1[0] - c0[0]) * frac) // R
    data[offset + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * frac) // G
    data[offset + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * frac) // B
    data[offset + 3] = 255 // A
  }

  return data
}

/** A BANDED (stepped) palette: a CONSTANT colour per value band, with HARD edges at the
 *  thresholds — S-100 portrayal semantics, NOT the smooth gradient `RAMPS` produce. */
export interface BandedRamp {
  /** [min, max] data domain the bands span. A layer using this ramp MUST declare
   *  `range: domain` so the GPU's normalized `t` lands the band edges at the right values. */
  domain: [number, number]
  /** Bands in ascending order; `upTo` is each band's EXCLUSIVE upper edge (last = Infinity). */
  bands: { upTo: number; color: [number, number, number] }[]
}

/** Banded palettes (stepped, non-uniform thresholds) — distinct from `RAMPS` (interpolated). */
export const BANDED_RAMPS: Record<string, BandedRamp> = {
  // Official IHO S-111 2.0.0 Portrayal Catalogue — surface-current SPEED bands, "Day" palette,
  // verbatim from 111_Portrayal_Catalogue_2.0.0 (SurfaceCurrentSpeedBand1..9 ranges +
  // colorProfile SCBN1..9 sRGB). Speed is in KNOTS; draw with `range: [0, 13]`.
  's111-speed': {
    domain: [0, 13],
    bands: [
      { upTo: 0.5, color: [118, 82, 226] }, // Band1  purple
      { upTo: 1.0, color: [72, 152, 211] }, // Band2  blue
      { upTo: 2.0, color: [97, 203, 229] }, // Band3  cyan
      { upTo: 3.0, color: [109, 188, 69] }, // Band4  green
      { upTo: 5.0, color: [180, 220, 0] }, // Band5   yellow-green
      { upTo: 7.0, color: [205, 193, 0] }, // Band6   yellow
      { upTo: 10.0, color: [248, 167, 24] }, // Band7 orange
      { upTo: 13.0, color: [247, 162, 157] }, // Band8 pink
      { upTo: Infinity, color: [255, 30, 30] }, // Band9 red
    ],
  },
}

/** Bake a banded palette into a dense STEPPED LUT (hard edges at the thresholds). Texel `i`
 *  maps to value = domain[0] + (i/(steps−1))·span, so a layer sampling with `range: domain`
 *  lands each band edge exactly. */
export function interpolateBandedRamp(banded: BandedRamp, steps: number): Uint8Array {
  const data = new Uint8Array(steps * 4)
  const [lo, hi] = banded.domain
  const span = hi - lo
  const last = banded.bands[banded.bands.length - 1]!
  for (let i = 0; i < steps; i++) {
    const v = lo + (i / (steps - 1)) * span
    const band = banded.bands.find((b) => v < b.upTo) ?? last
    const o = i * 4
    data[o] = band.color[0]
    data[o + 1] = band.color[1]
    data[o + 2] = band.color[2]
    data[o + 3] = 255
  }
  return data
}

/** CPU point-lookup: the sRGB [r,g,b] a BANDED palette assigns to `value` — the SAME band
 *  edges `interpolateBandedRamp` bakes into the GPU LUT (one authority). `value` is in the
 *  palette's DOMAIN units (e.g. knots for `s111-speed`). Returns null if `name` is not a
 *  banded ramp. Lets a CPU overlay (the S-111 arrow field) colour a glyph by the exact
 *  palette the coverage fill draws through, instead of copying the band table. */
export function bandedRampColor(name: string, value: number): [number, number, number] | null {
  const banded = BANDED_RAMPS[name]
  if (!banded) return null
  const last = banded.bands[banded.bands.length - 1]!
  return (banded.bands.find((b) => value < b.upTo) ?? last).color
}
