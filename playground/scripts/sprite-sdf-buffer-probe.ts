// Spritezero SDF buffer constant probe (icon-halo prerequisite, #2 of plan).
//
// icon-halo composite (Plan §4) needs the halo-width → SDF-distance
// normalisation constant. Sprites carry an externally pre-baked SDF
// in the PNG alpha (spritezero, server-side), so the constant is NOT
// in the codebase and guessing violates project_military_precision.
// This probe fetches the live OFM bright sprite, parses its JSON,
// reads the PNG alpha at each SDF entry, and reports the empirical
// edge value + buffer in pixels, statistically.
//
// Run: bun run scripts/sprite-sdf-buffer-probe.ts
//
// Output: spritezero edge alpha (byte) + buffer (px) histogram for
// OFM bright SDF icons. From those, the icon-halo normalisation
// follows the same shape as text-renderer's haloK formula:
//   halo_width_norm = halo_width_px · halo_K / icon_render_size
// where halo_K = ONE_EM_equivalent / SDF_PX = (255 - edgeByte) /
// SDF_PX (the spritezero distance-per-byte slope).

import { PNG } from 'pngjs'

const SPRITE_BASE = 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm'

interface SpriteEntry {
  x: number; y: number; width: number; height: number
  pixelRatio?: number; sdf?: boolean
}

async function fetchSprite(): Promise<{ json: Record<string, SpriteEntry>; png: PNG }> {
  const [jsonRes, pngRes] = await Promise.all([
    fetch(`${SPRITE_BASE}.json`),
    fetch(`${SPRITE_BASE}.png`),
  ])
  if (!jsonRes.ok) throw new Error(`sprite JSON HTTP ${jsonRes.status}`)
  if (!pngRes.ok) throw new Error(`sprite PNG HTTP ${pngRes.status}`)
  const json = await jsonRes.json() as Record<string, SpriteEntry>
  const pngBuf = Buffer.from(await pngRes.arrayBuffer())
  const png = PNG.sync.read(pngBuf)
  return { json, png }
}

/** Read alpha byte at (x,y) from a PNG with .data RGBA layout. */
function alphaAt(png: PNG, x: number, y: number): number {
  const idx = (y * png.width + x) * 4
  return png.data[idx + 3]!
}

interface AlphaStats {
  name: string
  size: { w: number; h: number }
  alphaHistogram: number[] // 256 buckets
  // Edge byte: the alpha value that appears most often along the icon's
  // axis-aligned mid-cross (horizontal + vertical center lines). At an
  // SDF icon's foreground boundary the gradient is roughly linear, so
  // crossing samples cluster around the on-edge alpha (= signed distance
  // 0 = the spritezero "buffer offset" point, conventionally ~192/255).
  medianAlphaOnMidCross: number
}

function analyseSdfEntry(name: string, e: SpriteEntry, png: PNG): AlphaStats {
  const hist = new Array(256).fill(0)
  const midX = e.x + Math.floor(e.width / 2)
  const midY = e.y + Math.floor(e.height / 2)
  const midCross: number[] = []
  // Full-entry histogram + mid-cross alpha samples.
  for (let dy = 0; dy < e.height; dy++) {
    for (let dx = 0; dx < e.width; dx++) {
      const a = alphaAt(png, e.x + dx, e.y + dy)
      hist[a]++
    }
  }
  for (let dx = 0; dx < e.width; dx++) midCross.push(alphaAt(png, e.x + dx, midY))
  for (let dy = 0; dy < e.height; dy++) midCross.push(alphaAt(png, midX, e.y + dy))
  midCross.sort((a, b) => a - b)
  return {
    name,
    size: { w: e.width, h: e.height },
    alphaHistogram: hist,
    medianAlphaOnMidCross: midCross[Math.floor(midCross.length / 2)]!,
  }
}

/** Find the dominant edge alpha — the byte at which the SDF gradient
 *  is steepest (largest delta between adjacent histogram buckets across
 *  many icons). Equivalent to "where the foreground/background boundary
 *  lives in alpha-space". */
function dominantEdgeByte(stats: AlphaStats[]): number {
  const summed = new Array(256).fill(0)
  for (const s of stats) for (let b = 0; b < 256; b++) summed[b] += s.alphaHistogram[b]
  // The on-edge alpha is the local minimum between the background
  // peak (alpha low) and the foreground peak (alpha high). Find it:
  // smooth, then take the lowest count in the middle 30..225 range.
  const smooth = new Array(256).fill(0)
  for (let b = 0; b < 256; b++) {
    let acc = 0, n = 0
    for (let k = -3; k <= 3; k++) {
      const bb = b + k
      if (bb >= 0 && bb < 256) { acc += summed[bb]; n++ }
    }
    smooth[b] = acc / n
  }
  let minB = 128, minV = Infinity
  for (let b = 32; b < 224; b++) {
    if (smooth[b] < minV) { minV = smooth[b]; minB = b }
  }
  return minB
}

async function main(): Promise<void> {
  console.log(`[probe] fetching ${SPRITE_BASE}.{json,png}`)
  const { json, png } = await fetchSprite()
  console.log(`[probe] sprite PNG ${png.width}×${png.height}, ${Object.keys(json).length} entries`)
  const sdfEntries = Object.entries(json).filter(([, e]) => e.sdf === true)
  console.log(`[probe] SDF entries: ${sdfEntries.length}`)
  if (sdfEntries.length === 0) {
    console.log('[probe] NO SDF entries in OFM bright sprite — icon-halo affects nothing in this style')
    return
  }
  const stats = sdfEntries.slice(0, 30).map(([name, e]) => analyseSdfEntry(name, e, png))
  console.log('\n[probe] per-entry median alpha on mid-cross (samples crossing the icon edge):')
  for (const s of stats) {
    console.log(`  ${s.name.padEnd(40)} ${s.size.w}×${s.size.h}   medianAlpha=${s.medianAlphaOnMidCross}`)
  }
  const edge = dominantEdgeByte(stats)
  console.log(`\n[probe] dominant edge alpha (histogram local-min): ${edge} / 255 = ${(edge / 255).toFixed(4)}`)
  console.log(`[probe] Mapbox convention edge byte = 192 (= 0.7529). If close → spritezero default;`)
  console.log(`[probe] differs → OFM uses custom buffer.`)
  // Distance-per-byte slope: at the edge, alpha changes by 255/SDF_PX per
  // pixel of signed distance. For Mapbox SDF_PX=8, slope ~32 bytes/px;
  // for SDF_PX=24/8 normalisation, slope differs. Report by sampling the
  // alpha gradient along the mid-cross of one icon.
  if (stats.length > 0) {
    const s0 = sdfEntries[0]!
    const name = s0[0], e = s0[1]
    const midY = e.y + Math.floor(e.height / 2)
    const alphas: number[] = []
    for (let dx = 0; dx < e.width; dx++) alphas.push(alphaAt(png, e.x + dx, midY))
    // Approx slope at the steepest 1-px transition
    let maxSlope = 0
    for (let i = 1; i < alphas.length; i++) {
      const d = Math.abs(alphas[i]! - alphas[i - 1]!)
      if (d > maxSlope) maxSlope = d
    }
    console.log(`\n[probe] icon "${name}" horizontal mid-line max 1-px alpha slope: ${maxSlope} bytes/px`)
    console.log(`[probe] → SDF_PX equivalent ≈ ${(255 / Math.max(1, maxSlope)).toFixed(2)} px per signed-distance unit`)
    console.log(`[probe] Mapbox default SDF_PX = 8; OFM_SDF_PX = ${(255 / Math.max(1, maxSlope)).toFixed(2)}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
