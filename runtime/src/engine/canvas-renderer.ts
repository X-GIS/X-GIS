// ═══ Canvas 2D Fallback Renderer ═══
// Used when WebGPU is not available (no GPU adapter, software rendering, etc.)
// Renders vector polygons and raster tiles using Canvas 2D API with CPU projections.

import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { getProjection, type Projection } from './projection'
import type { GeoJSONFeatureCollection } from '../loader/geojson'
import { visibleTiles, tileBounds, tileUrl, sortByPriority } from '../loader/tiles'

interface CanvasLayer {
  show: ShowCommand
  geojson: GeoJSONFeatureCollection | null
  tileUrl: string | null
}

const MAX_TILE_CACHE = 128

export class CanvasRenderer {
  private ctx2d: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private layers: CanvasLayer[] = []
  private tileCache = new Map<string, { img: HTMLImageElement; loaded: boolean }>()
  private loadingTiles = new Set<string>()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to get Canvas 2D context')
    this.ctx2d = ctx
  }

  addLayer(show: ShowCommand, data: GeoJSONFeatureCollection | null, tileUrl: string | null): void {
    this.layers.push({ show, geojson: data, tileUrl })
  }

  render(camera: Camera, projectionName: string): void {
    const dpr = window.devicePixelRatio || 1
    const cssW = this.canvas.clientWidth
    const cssH = this.canvas.clientHeight
    const w = Math.floor(cssW * dpr)
    const h = Math.floor(cssH * dpr)

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }

    const ctx = this.ctx2d
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    ctx.fillStyle = '#0a0a14'
    ctx.fillRect(0, 0, cssW, cssH)

    // Get projection
    const R = 6378137
    const centerLon = (camera.centerX / R) * (180 / Math.PI)
    const centerLat = Math.max(-89, Math.min(89,
      (2 * Math.atan(Math.exp(camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI),
    ))

    const proj = getProjection(projectionName, centerLon, centerLat)
    const [cx, cy] = proj.forward(centerLon, centerLat)
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, camera.zoom)

    // Transform: world coordinates → screen pixels
    const toScreen = (lon: number, lat: number): [number, number] => {
      const [px, py] = proj.forward(lon, lat)
      const sx = (px - cx) / metersPerPixel + cssW / 2
      const sy = -(py - cy) / metersPerPixel + cssH / 2
      return [sx, sy]
    }

    for (const layer of this.layers) {
      if (layer.show.visible === false) continue

      // Raster tiles
      if (layer.tileUrl) {
        this.renderTiles(ctx, camera, layer.tileUrl, toScreen, cssW, cssH)
        continue
      }

      // Vector GeoJSON
      if (layer.geojson) {
        this.renderGeoJSON(ctx, layer, toScreen)
      }
    }
  }

  private renderGeoJSON(
    ctx: CanvasRenderingContext2D,
    layer: CanvasLayer,
    toScreen: (lon: number, lat: number) => [number, number],
  ): void {
    const data = layer.geojson
    if (!data || !data.features) return

    const opacity = layer.show.opacity ?? 1
    ctx.globalAlpha = opacity

    for (const feature of data.features) {
      if (!feature.geometry) continue
      const { type, coordinates } = feature.geometry

      if (type === 'Polygon') {
        this.drawPolygon(ctx, coordinates as number[][][], layer.show, toScreen)
      } else if (type === 'MultiPolygon') {
        for (const poly of coordinates as number[][][][]) {
          this.drawPolygon(ctx, poly, layer.show, toScreen)
        }
      } else if (type === 'LineString') {
        this.drawLine(ctx, coordinates as number[][], layer.show, toScreen)
      } else if (type === 'MultiLineString') {
        for (const line of coordinates as number[][][]) {
          this.drawLine(ctx, line, layer.show, toScreen)
        }
      }
    }

    ctx.globalAlpha = 1
  }

  private drawPolygon(
    ctx: CanvasRenderingContext2D,
    rings: number[][][],
    show: ShowCommand,
    toScreen: (lon: number, lat: number) => [number, number],
  ): void {
    ctx.beginPath()
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [sx, sy] = toScreen(ring[i][0], ring[i][1])
        if (i === 0) ctx.moveTo(sx, sy)
        else ctx.lineTo(sx, sy)
      }
      ctx.closePath()
    }

    if (show.fill) {
      ctx.fillStyle = show.fill
      ctx.fill('evenodd')
    }
    if (show.stroke) {
      ctx.strokeStyle = show.stroke
      ctx.lineWidth = show.strokeWidth ?? 1
      ctx.stroke()
    }
  }

  private drawLine(
    ctx: CanvasRenderingContext2D,
    coords: number[][],
    show: ShowCommand,
    toScreen: (lon: number, lat: number) => [number, number],
  ): void {
    if (coords.length < 2) return
    ctx.beginPath()
    for (let i = 0; i < coords.length; i++) {
      const [sx, sy] = toScreen(coords[i][0], coords[i][1])
      if (i === 0) ctx.moveTo(sx, sy)
      else ctx.lineTo(sx, sy)
    }
    ctx.strokeStyle = show.stroke ?? '#888'
    ctx.lineWidth = show.strokeWidth ?? 1
    ctx.stroke()
  }

  private renderTiles(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    urlTemplate: string,
    toScreen: (lon: number, lat: number) => [number, number],
    cssW: number,
    cssH: number,
  ): void {
    const R = 6378137
    const centerLon = (camera.centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI)
    const tiles = visibleTiles(centerLon, centerLat, camera.zoom, cssW, cssH, undefined, camera.bearing, camera.pitch)

    const z = Math.max(0, Math.min(18, Math.round(camera.zoom)))
    const n = Math.pow(2, z)
    const ctX = Math.floor((centerLon + 180) / 360 * n)
    const ctY = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)
    sortByPriority(tiles, ctX, ctY)

    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      let cached = this.tileCache.get(key)

      if (!cached && !this.loadingTiles.has(key)) {
        this.loadingTiles.add(key)
        const img = new Image()
        img.crossOrigin = 'anonymous'
        cached = { img, loaded: false }
        this.tileCache.set(key, cached)

        const ref = cached
        img.onload = () => { ref.loaded = true; this.loadingTiles.delete(key) }
        img.onerror = () => { this.loadingTiles.delete(key); this.tileCache.delete(key) }
        img.src = tileUrl(urlTemplate, coord)

        // LRU eviction
        if (this.tileCache.size > MAX_TILE_CACHE) {
          const oldest = this.tileCache.keys().next().value
          if (oldest && oldest !== key) this.tileCache.delete(oldest)
        }
      }

      if (cached?.loaded) {
        const bounds = tileBounds(coord)
        const [x1, y1] = toScreen(bounds.west, bounds.north)
        const [x2, y2] = toScreen(bounds.east, bounds.south)
        const tw = x2 - x1
        const th = y2 - y1
        if (tw > 0.5 && th > 0.5) {
          ctx.drawImage(cached.img, x1, y1, tw, th)
        }
      }
    }
  }
}
