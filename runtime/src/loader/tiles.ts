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

/** Select visible tiles by unprojecting screen grid to lon/lat via projection inverse.
 *  Works correctly with any pitch, bearing, and projection combination. */
export function visibleTilesFrustum(
  camera: Camera,
  projection: Projection,
  z: number,
  canvasWidth: number,
  canvasHeight: number,
): TileCoord[] {
  const n = Math.pow(2, z)

  // Camera center in projection space (for RTC→absolute conversion)
  const [camProjX, camProjY] = projection.forward(
    (camera.centerX / 6378137) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(camera.centerY / 6378137)) - Math.PI / 2) * (180 / Math.PI),
  )

  // Sample screen grid (9×9 = 81 points) → unproject → lon/lat
  const lonLats: [number, number][] = []
  const GRID = 8
  for (let sx = 0; sx <= GRID; sx++) {
    for (let sy = 0; sy <= GRID; sy++) {
      const screenX = (sx / GRID) * canvasWidth
      const screenY = (sy / GRID) * canvasHeight

      const rtc = camera.unprojectToZ0(screenX, screenY, canvasWidth, canvasHeight)
      if (!rtc) continue // beyond horizon

      // RTC → absolute projection coords → lon/lat
      const result = projection.inverse(rtc[0] + camProjX, rtc[1] + camProjY)
      if (!result || isNaN(result[0]) || isNaN(result[1])) continue

      lonLats.push(result)
    }
  }

  if (lonLats.length === 0) {
    // Fallback: can't unproject anything (extreme pitch or projection)
    return visibleTiles(
      (camera.centerX / 6378137) * (180 / Math.PI),
      Math.max(-85, Math.min(85, (2 * Math.atan(Math.exp(camera.centerY / 6378137)) - Math.PI / 2) * (180 / Math.PI))),
      z, canvasWidth, canvasHeight, undefined, camera.bearing, camera.pitch,
    )
  }

  // Bounding box of all sampled lon/lat points
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lon, lat] of lonLats) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }

  // Clamp to valid tile range
  minLat = Math.max(-85.051, minLat)
  maxLat = Math.min(85.051, maxLat)

  // Convert lon/lat bounds to tile coordinates
  const minTileX = Math.floor((minLon + 180) / 360 * n)
  const maxTileX = Math.floor((maxLon + 180) / 360 * n)
  const minTileY = Math.max(0, Math.floor((1 - Math.log(Math.tan(maxLat * Math.PI / 180) + 1 / Math.cos(maxLat * Math.PI / 180)) / Math.PI) / 2 * n))
  const maxTileY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(minLat * Math.PI / 180) + 1 / Math.cos(minLat * Math.PI / 180)) / Math.PI) / 2 * n))

  const tiles: TileCoord[] = []
  const maxCopies = (WORLD_COPIES.length - 1) / 2

  for (let ox = minTileX; ox <= maxTileX; ox++) {
    const x = ((ox % n) + n) % n
    if (ox < -maxCopies * n || ox >= (maxCopies + 1) * n) continue
    for (let y = minTileY; y <= maxTileY; y++) {
      if (y < 0 || y >= n) continue
      tiles.push({ z, x, y, ox })
    }
  }

  // Limit total tile count (sort by distance from center)
  if (tiles.length > MAX_FRUSTUM_TILES) {
    const centerX = (camera.centerX / 6378137) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(camera.centerY / 6378137)) - Math.PI / 2) * (180 / Math.PI)
    const cx = Math.floor((centerX + 180) / 360 * n)
    const cy = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)
    tiles.sort((a, b) => {
      const da = (a.ox - cx) ** 2 + (a.y - cy) ** 2
      const db = (b.ox - cx) ** 2 + (b.y - cy) ** 2
      return da - db
    })
    tiles.length = MAX_FRUSTUM_TILES
  }

  return tiles
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
