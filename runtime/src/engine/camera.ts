// ═══ 2D Map Camera — 줌/패닝 ═══

import { lonLatToMercator } from '../loader/geojson'

export class Camera {
  /** Camera center in Web Mercator coordinates */
  centerX: number
  centerY: number
  /** Zoom level (0 = whole world, higher = closer) */
  zoom: number

  constructor(lon = 0, lat = 0, zoom = 2) {
    const [mx, my] = lonLatToMercator(lon, lat)
    this.centerX = mx
    this.centerY = my
    this.zoom = zoom
  }

  /** Get the view-projection matrix as Float32Array (column-major 4x4) */
  getMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    // Scale: at zoom 0, the whole world (~40M meters) fits in the viewport
    // Each zoom level doubles the scale
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const scaleX = 2 / (canvasWidth * metersPerPixel)
    const scaleY = 2 / (canvasHeight * metersPerPixel)

    // Translation: move camera center to origin
    const tx = -this.centerX * scaleX
    const ty = -this.centerY * scaleY

    // Column-major 4x4 orthographic matrix
    // prettier-ignore
    return new Float32Array([
      scaleX, 0,      0, 0,
      0,      scaleY, 0, 0,
      0,      0,      1, 0,
      tx,     ty,     0, 1,
    ])
  }

  /** RTC matrix: scale only, no translation (projection already centers to 0,0) */
  getRTCMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const scaleX = 2 / (canvasWidth * metersPerPixel)
    const scaleY = 2 / (canvasHeight * metersPerPixel)

    // prettier-ignore
    return new Float32Array([
      scaleX, 0,      0, 0,
      0,      scaleY, 0, 0,
      0,      0,      1, 0,
      0,      0,      0, 1,   // NO translation — RTC vertex shader already centered
    ])
  }

  /** Pan by CSS pixels (clientX/clientY delta) */
  pan(dx: number, dy: number, canvasWidth: number, canvasHeight: number): void {
    // Convert canvas physical pixels to CSS pixels for consistent DPR handling
    const cssWidth = canvasWidth / (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    const cssHeight = canvasHeight / (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    this.centerX -= dx * metersPerPixel
    this.centerY += dy * metersPerPixel
  }

  /** Zoom by delta at CSS screen position (clientX/clientY) */
  zoomAt(delta: number, screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): void {
    const oldZoom = this.zoom
    this.zoom = Math.max(0, Math.min(22, this.zoom + delta))

    // Use CSS dimensions for offset calculation (screenX/Y are CSS coordinates)
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const cssWidth = canvasWidth / dpr
    const cssHeight = canvasHeight / dpr

    const oldMPP = (40075016.686 / 256) / Math.pow(2, oldZoom)
    const newMPP = (40075016.686 / 256) / Math.pow(2, this.zoom)

    const offsetX = (screenX - cssWidth / 2)
    const offsetY = -(screenY - cssHeight / 2)

    this.centerX += offsetX * (oldMPP - newMPP)
    this.centerY += offsetY * (oldMPP - newMPP)
  }
}
