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
  if (pitch && pitch > 1) {
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
