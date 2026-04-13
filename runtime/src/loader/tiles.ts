// ═══ Raster Tile Loader — 웹 맵 타일 로딩 ═══
import { WORLD_COPIES } from '../engine/gpu-shared'

export interface TileCoord {
  z: number
  x: number   // wrapped x (0..2^z-1) for data lookup
  y: number
  ox?: number  // original x (may be < 0 or >= 2^z) for world-copy positioning
}

export interface LoadedTile {
  coord: TileCoord
  texture: GPUTexture
  // Tile bounds in lon/lat degrees
  west: number
  south: number
  east: number
  north: number
}

/** Calculate tile coordinates from lon/lat bounds and zoom level */
export function visibleTiles(
  centerLon: number,
  centerLat: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  cameraZoom?: number,
  bearing?: number,
  pitch?: number,
): TileCoord[] {
  const z = Math.max(0, Math.min(18, Math.round(zoom)))
  const n = Math.pow(2, z)

  // Center tile
  const cx = Math.floor((centerLon + 180) / 360 * n)
  const cy = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)

  // How many tiles fit in viewport — account for overzoom
  // At camera zoom >> tile zoom, each tile covers many screen pixels
  const effectiveZoom = cameraZoom ?? zoom
  const scale = Math.pow(2, effectiveZoom - z) // how many screen-tile-sizes per actual tile
  const tileSize = 256 * scale

  // When the map is rotated, the axis-aligned bounding box of the viewport
  // is larger than the viewport itself. Scale up by the AABB of a rotated rect.
  let effW = viewportWidth
  let effH = viewportHeight
  if (bearing) {
    const rad = Math.abs(bearing * Math.PI / 180)
    const cos = Math.abs(Math.cos(rad))
    const sin = Math.abs(Math.sin(rad))
    effW = viewportWidth * cos + viewportHeight * sin
    effH = viewportWidth * sin + viewportHeight * cos
  }

  const tilesX = Math.ceil(effW / tileSize / 2) + 1
  let tilesY = Math.ceil(effH / tileSize / 2) + 1

  // Pitch: camera tilted → need more tiles in the "forward" direction
  // Quantize pitch to 5° steps to stabilize tile set (prevents oscillation)
  if (pitch && pitch > 0) {
    const quantizedPitch = Math.ceil(Math.min(pitch, 85) / 5) * 5
    const pitchFactor = 1 / Math.cos(quantizedPitch * Math.PI / 180)
    const extra = Math.ceil(tilesY * (pitchFactor - 1))
    tilesY += Math.min(extra, tilesY * 4)
  }

  const tiles: TileCoord[] = []

  // Wrap cx to [0, n) so world copies are symmetric around the primary world
  const wrappedCx = ((cx % n) + n) % n
  const wrapOffset = cx - wrappedCx  // how many tiles the camera is shifted

  for (let dx = -tilesX; dx <= tilesX; dx++) {
    for (let dy = -tilesY; dy <= tilesY; dy++) {
      const ox = wrapOffset + wrappedCx + dx
      const y = cy + dy
      if (y < 0 || y >= n) continue
      const x = ((ox % n) + n) % n

      // Limit world copies: ox must be within [-n, 2n) → at most 3 worlds
      // (MapLibre-style: primary world + one copy left + one copy right)
      // Limit world copies based on WORLD_COPIES range
      const maxCopies = (WORLD_COPIES.length - 1) / 2  // e.g., [-2,-1,0,1,2] → 2
      if (ox < -maxCopies * n || ox >= (maxCopies + 1) * n) continue

      tiles.push({ z, x, y, ox })
    }
  }
  return tiles
}

// ═══ Frustum-based tile selection ═══

import type { Camera } from '../engine/camera'
import type { Projection } from '../engine/projection'

const MAX_FRUSTUM_TILES = 300

/** Quadtree-based visible tile selection.
 *  Recursively subdivides from z=0, using screen-space tile size to determine LOD.
 *  Near tiles get high zoom, far tiles get low zoom — natural perspective LOD. */
export function visibleTilesFrustum(
  camera: Camera,
  projection: Projection,
  maxZ: number,
  canvasWidth: number,
  canvasHeight: number,
): TileCoord[] {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)
  const camMercX = camera.centerX
  const camMercY = camera.centerY
  const maxCopies = (WORLD_COPIES.length - 1) / 2
  const SUBDIVIDE_THRESHOLD = 400 // subdivide if tile > this many px on screen

  // Project Mercator coords → screen pixel (returns null if behind camera)
  const toScreen = (mx: number, my: number): [number, number] | null => {
    const rx = mx - camMercX, ry = my - camMercY
    const cw = mvp[3] * rx + mvp[7] * ry + mvp[15]
    if (cw <= 0.01) return null
    const cx = mvp[0] * rx + mvp[4] * ry + mvp[12]
    const cy = mvp[1] * rx + mvp[5] * ry + mvp[13]
    return [(cx / cw + 1) * 0.5 * canvasWidth, (1 - cy / cw) * 0.5 * canvasHeight]
  }

  // Lon/lat → Mercator meters
  const lonToMerc = (lon: number) => lon * DEG2RAD * R
  const latToMerc = (lat: number) => {
    const cl = Math.max(-85.051, Math.min(85.051, lat))
    return Math.log(Math.tan(Math.PI / 4 + cl * DEG2RAD / 2)) * R
  }

  // Tile y → latitude (north edge)
  const tileYToLat = (y: number, n: number) =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI

  // Estimate tile's screen-space size in pixels
  const tileScreenSize = (tz: number, ox: number, y: number): number => {
    const tn = Math.pow(2, tz)
    const lonW = ox / tn * 360 - 180
    const lonE = (ox + 1) / tn * 360 - 180
    const latN = tileYToLat(y, tn)
    const latS = tileYToLat(y + 1, tn)
    const mw = lonToMerc(lonW), me = lonToMerc(lonE)
    const mn = latToMerc(latN), ms = latToMerc(latS)

    const corners = [toScreen(mw, ms), toScreen(me, ms), toScreen(me, mn), toScreen(mw, mn)]
    let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity
    let valid = 0
    for (const c of corners) {
      if (!c) continue
      valid++
      if (c[0] < sxMin) sxMin = c[0]
      if (c[0] > sxMax) sxMax = c[0]
      if (c[1] < syMin) syMin = c[1]
      if (c[1] > syMax) syMax = c[1]
    }
    if (valid < 2) return 0
    return Math.max(sxMax - sxMin, syMax - syMin)
  }

  // Check if tile is potentially visible (screen AABB overlaps viewport)
  const isTileVisible = (tz: number, ox: number, y: number): boolean => {
    const tn = Math.pow(2, tz)
    const lonW = ox / tn * 360 - 180
    const lonE = (ox + 1) / tn * 360 - 180
    const latN = tileYToLat(y, tn)
    const latS = tileYToLat(y + 1, tn)
    const mw = lonToMerc(lonW), me = lonToMerc(lonE)
    const mn = latToMerc(latN), ms = latToMerc(latS)

    const corners = [toScreen(mw, ms), toScreen(me, ms), toScreen(me, mn), toScreen(mw, mn)]
    let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity
    let valid = 0
    for (const c of corners) {
      if (!c) { valid++; continue } // behind camera = might wrap around, be conservative
      valid++
      if (c[0] < sxMin) sxMin = c[0]
      if (c[0] > sxMax) sxMax = c[0]
      if (c[1] < syMin) syMin = c[1]
      if (c[1] > syMax) syMax = c[1]
    }
    if (valid === 0) return false
    if (sxMin === Infinity) return true // all behind camera at low zoom — be conservative
    // Generous margin for partially-visible tiles
    const margin = Math.max(canvasWidth, canvasHeight) * 0.1
    return sxMax >= -margin && sxMin <= canvasWidth + margin &&
           syMax >= -margin && syMin <= canvasHeight + margin
  }

  const result: TileCoord[] = []

  const visit = (tz: number, x: number, y: number, ox: number): void => {
    if (result.length >= MAX_FRUSTUM_TILES) return
    const tn = Math.pow(2, tz)
    if (y < 0 || y >= tn) return
    if (ox < -maxCopies * tn || ox >= (maxCopies + 1) * tn) return

    // Low-zoom tiles always visible (screen projection unreliable for world-scale tiles)
    if (tz > 3 && !isTileVisible(tz, ox, y)) return

    const screenPx = tz <= 3 ? SUBDIVIDE_THRESHOLD + 1 : tileScreenSize(tz, ox, y)

    // Subdivide if tile is large on screen and we haven't reached max zoom
    if (tz < maxZ && screenPx > SUBDIVIDE_THRESHOLD && result.length + 4 <= MAX_FRUSTUM_TILES) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          visit(tz + 1, x * 2 + dx, y * 2 + dy, ox * 2 + dx)
        }
      }
      return
    }

    if (screenPx > 0 || tz <= 2) { // always include low-zoom tiles for coverage
      result.push({ z: tz, x, y, ox })
    }
  }

  // Start from z=0 for each world copy
  for (let wx = -maxCopies; wx <= maxCopies; wx++) {
    visit(0, 0, 0, wx)
  }

  return result
}

/** Get lon/lat bounds for a tile */
export function tileBounds(coord: TileCoord): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, coord.z)
  const west = coord.x / n * 360 - 180
  const east = (coord.x + 1) / n * 360 - 180
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * coord.y / n))) * 180 / Math.PI
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + 1) / n))) * 180 / Math.PI
  return { west, south, east, north }
}

/** Build tile URL from template */
export function tileUrl(template: string, coord: TileCoord): string {
  return template
    .replace('{z}', String(coord.z))
    .replace('{x}', String(coord.x))
    .replace('{y}', String(coord.y))
}

/** Check if a URL is a tile template */
export function isTileTemplate(url: string): boolean {
  return url.includes('{z}') && url.includes('{x}') && url.includes('{y}')
}

/** Load an image as a GPU texture (supports AbortSignal for cancellation) */
export async function loadImageTexture(
  device: GPUDevice,
  url: string,
  signal?: AbortSignal,
): Promise<GPUTexture | null> {
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const blob = await response.blob()
    if (signal?.aborted) return null
    const bitmap = await createImageBitmap(blob)

    const texture = device.createTexture({
      size: { width: bitmap.width, height: bitmap.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })

    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      { width: bitmap.width, height: bitmap.height },
    )

    bitmap.close()
    return texture
  } catch {
    return null
  }
}

/**
 * Sort tiles by distance from center (closest first → highest priority).
 */
export function sortByPriority(tiles: TileCoord[], centerTileX: number, centerTileY: number): TileCoord[] {
  return tiles.sort((a, b) => {
    // Use original x (ox) for distance — correct for world copies
    const ax = a.ox ?? a.x
    const bx = b.ox ?? b.x
    const da = Math.abs(ax - centerTileX) + Math.abs(a.y - centerTileY)
    const db = Math.abs(bx - centerTileX) + Math.abs(b.y - centerTileY)
    return da - db
  })
}
