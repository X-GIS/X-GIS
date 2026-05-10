// Diagnostic / snapshot helpers for XGISMap.
//
// Three operations live here, all public-API-surface helpers that
// XGISMap exposes through wafer-thin delegate methods:
//
//   inspectMapPipeline(map)  → structured snapshot of camera + per-
//                              source tile state. Console-friendly.
//                              Driven by `__xgisMap.inspectPipeline()`.
//   captureMapSnapshot(map)  → async snapshot with pixel hash. Used by
//                              the e2e replay tests through
//                              `window.__xgisSnapshot`.
//   replayMapSnapshot(map,…) → drive the live runtime back to a captured
//                              state and resolve once tile state matches.
//                              Driven by `window.__xgisReplaySnapshot`.
//
// Extracted from map.ts so the orchestrator can stay focused on the
// per-frame render loop. Functions accept the XGISMap instance as a
// parameter; private-state reads use a single `as unknown as { … }`
// cast at the boundary, keeping the diagnostic-only access pattern out
// of the class's public type.

import { tileKey as compilerTileKey } from '@xgis/compiler'
import { getMaxDpr } from './gpu/gpu'
import type { QualityConfig } from './gpu/quality'
import type { XGISMap } from './map'

// ─── Types ─────────────────────────────────────────────────────────

/** Structured return type of `XGISMap.inspectPipeline()`. Every field
 *  reports LIVE runtime state (not a simulation) so CPU debug sessions
 *  can correlate a specific frame's tile-selection decisions with the
 *  cache / budget pressure that drove them. */
export interface PipelineInspection {
  camera: {
    zoom: number
    lon: number
    lat: number
    bearing: number
    pitch: number
    maxZoom: number
  }
  viewport: { canvasW: number; canvasH: number; dpr: number }
  /** Monotonic render-loop tick counter (since run()). Useful for
   *  comparing two snapshots taken across a known interval. */
  frame: number
  quality: QualityConfig
  /** True when hash sync / pointer interaction / setView declared the
   *  camera explicitly — post-compile bounds-fit is suppressed in that
   *  case. */
  cameraExplicitlyPositioned: boolean
  sources: Array<{
    name: string
    /** Deepest zoom the source CAN serve as genuine data. Over-zooming
     *  past this forces runtime sub-tile generation. */
    sourceMaxLevel: number
    currentZoomRounded: number
    /** `max(0, zoom - sourceMaxLevel)`. Non-zero means every visible
     *  tile at this zoom requires a sub-tile-generation pass. */
    overzoomLevels: number
    cache: {
      size: number
      pendingLoads: number
      pendingUploads: number
      subTileBudgetUsed: number
      compileBudgetUsed: number
      hasData: boolean
    }
    frame: {
      drawCalls: number
      tilesVisible: number
      missedTiles: number
      triangles: number
      lines: number
    }
  }>
  /** Recent FLICKER ring-buffer events (oldest first). Empty in
   *  steady state; populated when the per-source missedTiles gate
   *  fired within the last ~32 dispatches. */
  recentFlickers: Array<{
    ts: number
    source: string
    missed: number
    z: number
    cache: number
  }>
}

/** Captured snapshot for e2e replay. Schema-versioned so older
 *  snapshots can be detected on replay. */
export interface MapSnapshot {
  schemaVersion: 1
  pageUrl: string
  userAgent: string
  camera: { lon: number; lat: number; zoom: number; bearing: number; pitch: number }
  /** Backing-buffer + CSS-pixel size + DPR. Reproduction needs ALL
   *  THREE — backing buffer drives shader uniforms, CSS size drives
   *  layout, DPR ties them and gates mobile-class decisions. */
  viewport: { width: number; height: number; cssWidth: number; cssHeight: number; dpr: number }
  /** Page-level viewport (window.innerWidth / innerHeight). Replay
   *  must set the playwright context to this exact size or the canvas
   *  shrinks/grows and pixel hashes won't compare. */
  pageViewport: { width: number; height: number }
  sources: Record<string, {
    gpuCacheCount: number
    pendingFetch: number
    pendingUpload: number
    tiles: Array<{ z: number; x: number; y: number }>
  }>
  renderOrder: unknown[]
  pixelHash: string
  pixelHashBy: 'subtle' | 'fnv'
}

export interface ReplayResult {
  matched: boolean
  missingTiles: number
  pendingFetchTotal: number
  pendingUploadTotal: number
}

// ─── Inspection (sync, console-friendly) ───────────────────────────

/** Snapshot of everything a human needs to debug the tile pipeline at
 *  CPU level. Safe to call every frame — no GPU work, no allocations
 *  beyond the result struct. */
export function inspectMapPipeline(map: XGISMap): PipelineInspection {
  const m = map as unknown as {
    camera: {
      centerX: number; centerY: number; zoom: number;
      bearing: number; pitch: number; maxZoom: number;
    }
    ctx?: { canvas: { width: number; height: number } }
    vtSources: Map<string, {
      source: {
        maxLevel: number
        getPendingLoadCount(): number
        hasData(): boolean
        getSubTileBudgetUsed(): number
        getCompileBudgetUsed(): number
      }
      renderer: {
        getDrawStats(): {
          drawCalls: number; tilesVisible: number; missedTiles: number;
          triangles: number; lines: number;
        }
        getCacheSize(): number
        getPendingUploadCount(): number
      }
    }>
    _frameCount: number
    getQuality(): QualityConfig
    _cameraExplicitlyPositioned: boolean
    _flickerLog: Array<{ ts: number; source: string; missed: number; z: number; cache: number }>
  }

  const cam = m.camera
  const R = 6378137
  const DEG = 180 / Math.PI
  const canvasW = m.ctx?.canvas.width ?? 0
  const canvasH = m.ctx?.canvas.height ?? 0
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1

  const lon = (cam.centerX / R) * DEG
  const lat = (2 * Math.atan(Math.exp(cam.centerY / R)) - Math.PI / 2) * DEG

  const sources: PipelineInspection['sources'] = []
  for (const [name, entry] of m.vtSources) {
    const source = entry.source
    const vtR = entry.renderer
    const stats = vtR.getDrawStats()
    const sourceMaxLevel = source.maxLevel
    const overzoom = Math.max(0, Math.round(cam.zoom) - sourceMaxLevel)
    sources.push({
      name,
      sourceMaxLevel,
      currentZoomRounded: Math.round(cam.zoom),
      overzoomLevels: overzoom,
      cache: {
        size: vtR.getCacheSize(),
        pendingLoads: source.getPendingLoadCount(),
        pendingUploads: vtR.getPendingUploadCount(),
        subTileBudgetUsed: source.getSubTileBudgetUsed(),
        compileBudgetUsed: source.getCompileBudgetUsed(),
        hasData: source.hasData(),
      },
      frame: {
        drawCalls: stats.drawCalls,
        tilesVisible: stats.tilesVisible,
        missedTiles: stats.missedTiles,
        triangles: stats.triangles,
        lines: stats.lines,
      },
    })
  }

  return {
    camera: {
      zoom: cam.zoom,
      lon, lat,
      bearing: cam.bearing,
      pitch: cam.pitch,
      maxZoom: cam.maxZoom,
    },
    viewport: { canvasW, canvasH, dpr },
    frame: m._frameCount,
    quality: m.getQuality(),
    cameraExplicitlyPositioned: m._cameraExplicitlyPositioned,
    sources,
    recentFlickers: [...m._flickerLog],
  }
}

// ─── Snapshot capture (async, includes pixel hash) ─────────────────

/** Async snapshot with pixel hash — used by e2e replay tests through
 *  `window.__xgisSnapshot`. The hash uses SubtleCrypto SHA-256 in
 *  secure contexts and falls back to FNV-1a otherwise. */
export async function captureMapSnapshot(map: XGISMap): Promise<MapSnapshot> {
  const m = map as unknown as {
    camera: { centerX: number; centerY: number; zoom: number; bearing?: number; pitch?: number }
    canvas: HTMLCanvasElement
    vtSources?: Map<string, unknown>
  }
  const camera = m.camera
  const lon = (camera.centerX / 6378137) / (Math.PI / 180)
  const lat = (2 * Math.atan(Math.exp(camera.centerY / 6378137)) - Math.PI / 2) / (Math.PI / 180)

  const sources: MapSnapshot['sources'] = {}
  if (m.vtSources) {
    for (const [name, entry] of m.vtSources) {
      const r = (entry as unknown as { renderer?: {
        _gpuCacheCount?: number
        getPendingUploadCount?: () => number
        _frameTileCache?: { tiles?: Array<{ z: number; x: number; y: number }> }
      } }).renderer
      const cat = (entry as unknown as { source?: { getPendingLoadCount?: () => number } }).source
      sources[name] = {
        gpuCacheCount: r?._gpuCacheCount ?? 0,
        pendingFetch: cat?.getPendingLoadCount?.() ?? 0,
        pendingUpload: r?.getPendingUploadCount?.() ?? 0,
        tiles: r?._frameTileCache?.tiles ?? [],
      }
    }
  }

  const renderOrder = ((window as unknown as {
    __xgisDrawOrderTrace?: unknown[]
  }).__xgisDrawOrderTrace) ?? []

  // Pixel hash: SubtleCrypto SHA-256 where available, FNV-1a fallback.
  // Canvas readback via toBlob → arrayBuffer (deterministic for the
  // same pixel data) — avoids creating an extra GPU texture.
  const canvas = m.canvas
  let pixelHash = ''
  let pixelHashBy: 'subtle' | 'fnv' = 'fnv'
  try {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png')
    })
    if (blob) {
      const buf = await blob.arrayBuffer()
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', buf)
        const bytes = Array.from(new Uint8Array(digest))
        pixelHash = bytes.map(b => b.toString(16).padStart(2, '0')).join('')
        pixelHashBy = 'subtle'
      } else {
        // FNV-1a 32-bit. Lower entropy but adequate for detecting
        // frame-by-frame drift in tests.
        let h = 0x811c9dc5
        const u8 = new Uint8Array(buf)
        for (let i = 0; i < u8.length; i++) {
          h ^= u8[i]
          h = (h * 0x01000193) >>> 0
        }
        pixelHash = h.toString(16).padStart(8, '0')
        pixelHashBy = 'fnv'
      }
    }
  } catch (e) {
    console.warn('[xgisSnapshot] pixel hash failed:', e)
  }

  const cssWidth = canvas.clientWidth || canvas.width
  const cssHeight = canvas.clientHeight || canvas.height
  const dpr = cssWidth > 0 ? canvas.width / cssWidth : 1
  const pageWidth = typeof window !== 'undefined' ? window.innerWidth : cssWidth
  const pageHeight = typeof window !== 'undefined' ? window.innerHeight : cssHeight

  return {
    schemaVersion: 1,
    pageUrl: typeof window !== 'undefined' ? window.location.href : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    camera: {
      lon, lat,
      zoom: camera.zoom,
      bearing: camera.bearing ?? 0,
      pitch: camera.pitch ?? 0,
    },
    viewport: {
      width: canvas.width, height: canvas.height,
      cssWidth, cssHeight, dpr,
    },
    pageViewport: { width: pageWidth, height: pageHeight },
    sources,
    renderOrder,
    pixelHash,
    pixelHashBy,
  }
}

// ─── Snapshot replay (async, drives map back to captured state) ────

/** Replay a captured snapshot. Sets the camera back to the snapshot
 *  position, then resolves once the live state matches the snapshot
 *  closely enough that pixel-hash comparison is meaningful:
 *    - Every snapshot tile is present in the live source's GPU cache
 *    - Every source has zero pending fetch / pending upload
 *
 *  Caller (e2e test) is responsible for setting the viewport BEFORE
 *  this runs — playwright's setViewportSize + deviceScaleFactor handle
 *  that. The replay returns a fresh snapshot for the test to compare. */
export async function replayMapSnapshot(
  map: XGISMap,
  snap: {
    schemaVersion?: number
    camera: { lon: number; lat: number; zoom: number; bearing: number; pitch: number }
    sources: Record<string, { tiles: Array<{ z: number; x: number; y: number }> }>
  },
  opts: { timeoutMs?: number } = {},
): Promise<ReplayResult> {
  if (snap.schemaVersion !== undefined && snap.schemaVersion !== 1) {
    throw new Error(`replaySnapshot: unsupported schema ${snap.schemaVersion} (this build supports 1)`)
  }
  const timeoutMs = opts.timeoutMs ?? 30_000
  const m = map as unknown as {
    camera: { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
    _cameraExplicitlyPositioned: boolean
    _needsRender: boolean
    vtSources?: Map<string, unknown>
  }

  // 1. Set the camera. Direct field assignment bypasses setView so
  // animation tweens don't drift the snapshot camera over the next
  // few frames.
  const R = 6378137
  const DEG2RAD = Math.PI / 180
  m.camera.centerX = snap.camera.lon * DEG2RAD * R
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, snap.camera.lat))
  m.camera.centerY = Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) * R
  m.camera.zoom = snap.camera.zoom
  m.camera.bearing = snap.camera.bearing
  m.camera.pitch = snap.camera.pitch
  m._cameraExplicitlyPositioned = true
  m._needsRender = true

  // 2. Wait until each source has every snapshot tile in its GPU
  // cache. Tile set comparison uses (z,x,y) tuples. Extra tiles
  // beyond the snapshot are tolerated — replay-side may carry over
  // fallback ancestors that the original capture didn't list.
  const computeStatus = (): ReplayResult | null => {
    let pendingFetchTotal = 0
    let pendingUploadTotal = 0
    let missingTiles = 0
    let sourceMissing = false
    for (const [name, snapSrc] of Object.entries(snap.sources)) {
      const live = (m.vtSources?.get(name) as unknown as {
        source?: { hasTileData?: (key: number) => boolean; getPendingLoadCount?: () => number }
        renderer?: { getPendingUploadCount?: () => number }
      } | undefined)
      if (!live?.source) {
        sourceMissing = true
        missingTiles += snapSrc.tiles.length
        continue
      }
      const cat = live.source as { hasTileData?: (key: number) => boolean; getPendingLoadCount?: () => number }
      pendingFetchTotal += cat.getPendingLoadCount?.() ?? 0
      pendingUploadTotal += live.renderer?.getPendingUploadCount?.() ?? 0
      for (const t of snapSrc.tiles) {
        // tileKey packing must match the runtime's encoder; pull from
        // the compiler so we don't fork the format.
        const key = compilerTileKey(t.z, t.x, t.y)
        if (!cat.hasTileData?.(key)) missingTiles++
      }
    }
    if (sourceMissing) {
      return { matched: false, missingTiles, pendingFetchTotal, pendingUploadTotal }
    }
    if (missingTiles === 0 && pendingFetchTotal === 0 && pendingUploadTotal === 0) {
      return { matched: true, missingTiles: 0, pendingFetchTotal: 0, pendingUploadTotal: 0 }
    }
    return null
  }

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = computeStatus()
    if (status) return status
    // Yield to the render loop so tiles can fetch / decode / upload.
    await new Promise<void>((res) => setTimeout(res, 100))
  }
  // Timeout — return current state for caller to inspect.
  return computeStatus() ?? { matched: false, missingTiles: 0, pendingFetchTotal: 0, pendingUploadTotal: 0 }
}
