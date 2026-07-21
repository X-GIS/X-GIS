// ═══ gen-synthetic-currents — deterministic S-111-shaped demo .xgcov (bun/node) ═══
//
// Emits the committed playground demo artifact (synthetic-currents.xgcov): a
// CLOSED-FORM synthetic surface-current field over a Chesapeake-Bay-shaped box —
// a northward tidal channel plus a counter-clockwise gyre, with coast-shaped
// nodata margins — carrying the S-111 band names/units/fill (-9999) so the demo
// exercises exactly what a converted real NOAA cell would (#1272). NOT real NOAA
// data (sourceMeta says so); real cells stay local-only for licensing, like S-102.
// Deterministic by construction (no RNG, no clock) so regeneration is byte-stable.
//
// ── I/O CONTRACT (A6 — §12 read-the-header rule; mirrors s100-to-xgcov.ts) ──
//   • `--out <file>` is REQUIRED (error + non-zero exit if absent).
//   • The artifact bytes go ONLY to `--out`, NEVER to stdout.
//   • stdout = a human summary; after writing, the output is `stat`-ed.
//
// Usage:
//   bun pipeline/tools/gen-synthetic-currents.ts --out playground/public/synthetic-currents.xgcov

import { writeFileSync, statSync } from 'node:fs'
// Same barrel-free subpath the s100-to-xgcov CLI uses (devDep edge; the
// '@xgis/data' barrel's Vite `?worker` imports don't load under plain bun).
import { encodeCoverage, type CoverageInput } from '@xgis/data/coverage'

const FILL = -9999
// Grid: 32×48 cells, SW cell CENTRE origin, EPSG:4326 degrees.
const N_LON = 32
const N_LAT = 48
const ORIGIN: [number, number] = [-76.58, 36.85]
const SPACING: [number, number] = [0.025, 0.055]

function parseOut(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--out') return argv[i + 1] ?? ''
  return ''
}

function main(): Promise<void> {
  const out = parseOut(process.argv.slice(2))
  if (!out) {
    process.stderr.write('[gen-synthetic-currents] error: --out <file> is REQUIRED\n')
    process.exit(1)
  }

  const cells = N_LON * N_LAT
  const speed = new Float32Array(cells) // knots
  const direction = new Float32Array(cells) // arc-degrees, 0 = true north, CW
  const D2R = Math.PI / 180

  // NORTH-UP rows (row 0 = northernmost), matching the .xgcov storage order.
  for (let row = 0; row < N_LAT; row++) {
    // gy: northward fraction (0 = south edge, 1 = north edge).
    const gy = 1 - row / (N_LAT - 1)
    // Coast-shaped nodata margins — the "land" the ramp's soft rim shows.
    const westLand = 0.1 + 0.06 * Math.sin(gy * 5.1)
    const eastLand = 0.1 + 0.06 * Math.cos(gy * 3.7)
    for (let col = 0; col < N_LON; col++) {
      const i = row * N_LON + col
      const gx = col / (N_LON - 1)
      const island = Math.hypot(gx - 0.62, gy - 0.55) < 0.045
      if (gx < westLand || gx > 1 - eastLand || island) {
        speed[i] = FILL
        direction[i] = FILL
        continue
      }
      // Northward tidal channel, fastest mid-channel, with a gentle meander.
      const ch = Math.pow(Math.max(0, 1 - Math.abs(gx - 0.5) / 0.5), 1.5)
      const chSpeed = 1.4 * ch
      const chDir = -18 * Math.sin(gy * 4.2) * D2R // tilt around north
      let u = chSpeed * Math.sin(chDir) // east component
      let v = chSpeed * Math.cos(chDir) // north component
      // Counter-clockwise gyre — a ring of tangential flow mid-bay.
      const dx = gx - 0.5
      const dy = gy - 0.42
      const r = Math.hypot(dx, dy)
      if (r > 1e-6) {
        const g = 1.0 * Math.exp(-Math.pow((r - 0.16) / 0.09, 2))
        u += (g * -dy) / r
        v += (g * dx) / r
      }
      const s = Math.min(2.2, Math.hypot(u, v))
      speed[i] = s
      direction[i] = (Math.atan2(u, v) / D2R + 360) % 360
    }
  }

  const input: CoverageInput = {
    product: 's111',
    origin: ORIGIN,
    spacing: SPACING,
    size: [N_LON, N_LAT],
    bands: [
      { name: 'surfaceCurrentSpeed', unit: 'knots', kind: 'f32', nodata: FILL, values: speed },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degree',
        kind: 'f32',
        nodata: FILL,
        values: direction,
      },
    ],
    vertical: { datumCode: null, sign: 'down' },
    sourceMeta: {
      synthetic: true,
      note: 'closed-form tidal channel + gyre demo field — NOT real NOAA data',
    },
  }

  return encodeCoverage(input).then((artifact) => {
    writeFileSync(out, Buffer.from(artifact))
    const size = statSync(out).size // exit 0 ≠ file written — stat and report
    let valid = 0
    let max = 0
    for (const s of speed)
      if (s !== FILL) {
        valid++
        if (s > max) max = s
      }
    process.stdout.write(
      [
        `grid:    ${N_LON} × ${N_LAT} cells (f32 ×2 bands)`,
        `valid:   ${valid}/${cells} cells, speed max ${max.toFixed(2)} kn`,
        `wrote:   ${out}  (${size} bytes)`,
      ].join('\n') + '\n',
    )
  })
}

main().catch((e) => {
  process.stderr.write(
    `[gen-synthetic-currents] error: ${e instanceof Error ? e.message : String(e)}\n`,
  )
  process.exit(1)
})
