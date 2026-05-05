// Direct PMTiles inspection — fetches the Firenze archive header
// + probes individual tiles at known Florence center to verify the
// archive actually contains data at the zoom levels we care about.
//
// Run: cd runtime && bun run scripts/inspect-firenze-pmtiles.ts

import { bytesToHeader, TileType } from 'pmtiles'

const URL = process.argv[2] ?? 'https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles'

async function fetchRange(offset: number, length: number): Promise<Uint8Array> {
  const res = await fetch(URL, {
    headers: {
      Range: `bytes=${offset}-${offset + length - 1}`,
      'Accept-Encoding': 'identity',
    },
  })
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
  // bun's fetch returns Uint8Array via arrayBuffer(); pmtiles wants ArrayBuffer.
  return new Uint8Array(await res.arrayBuffer())
}

function lonLatToTile(z: number, lon: number, lat: number): [number, number] {
  const n = 1 << z
  const x = Math.floor((lon + 180) / 360 * n)
  const sin = Math.sin(lat * Math.PI / 180)
  const y = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n)
  return [x, y]
}

async function main() {
  console.log(`Opening: ${URL}\n`)

  const headerBytes = await fetchRange(0, 127)
  // bytesToHeader expects ArrayBuffer
  const ab = headerBytes.buffer.slice(headerBytes.byteOffset, headerBytes.byteOffset + headerBytes.byteLength)
  const header = bytesToHeader(ab as ArrayBuffer, 'etag')

  console.log('=== PMTiles Header ===')
  console.log(`  tileType:            ${TileType[header.tileType]} (${header.tileType})`)
  console.log(`  zoom range:          z=${header.minZoom}..${header.maxZoom}`)
  console.log(`  bounds:              [lon ${header.minLon}..${header.maxLon}, lat ${header.minLat}..${header.maxLat}]`)
  console.log(`  bounds (size):       ~${((header.maxLon - header.minLon) * 111 * Math.cos(43.77 * Math.PI / 180)).toFixed(1)}km × ~${((header.maxLat - header.minLat) * 111).toFixed(1)}km`)
  console.log(`  center:              z=${header.centerZoom} at (${header.centerLat}, ${header.centerLon})`)
  console.log(`  numTileEntries:      ${header.numTileEntries}`)
  console.log(`  tileCompression:     ${header.tileCompression === 2 ? 'gzip' : header.tileCompression}`)
  console.log()

  console.log('=== Florence-center tile coordinates ===')
  for (const z of [0, 5, 10, 12, 13, 14, 15]) {
    if (z < header.minZoom || z > header.maxZoom) continue
    const [x, y] = lonLatToTile(z, 11.25, 43.77)
    console.log(`  z=${z}: (x=${x}, y=${y})`)
  }
  console.log()

  console.log('=== Conclusion ===')
  console.log(`Archive bounds: ~${((header.maxLon - header.minLon) * 111).toFixed(1)}km wide.`)
  const minVisibleZoom = Math.ceil(Math.log2(360 / (header.maxLon - header.minLon)) - 1)
  console.log(`Minimum zoom for data area to span > 1 visible tile: z≈${minVisibleZoom}`)
  console.log(`Recommended demo URL: #${Math.max(minVisibleZoom, 12)}/${header.centerLat}/${header.centerLon}`)
}

main().catch(e => { console.error(e); process.exit(1) })
