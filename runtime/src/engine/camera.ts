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

  /** Pan by screen pixels */
  pan(dx: number, dy: number, canvasWidth: number, canvasHeight: number): void {
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    this.centerX -= dx * metersPerPixel
    this.centerY += dy * metersPerPixel
  }

  /** Zoom by delta at screen position */
  zoomAt(delta: number, screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): void {
    const oldZoom = this.zoom
    this.zoom = Math.max(0, Math.min(22, this.zoom + delta))

    // Zoom toward mouse position
    const oldMPP = (40075016.686 / 256) / Math.pow(2, oldZoom)
    const newMPP = (40075016.686 / 256) / Math.pow(2, this.zoom)

    const offsetX = (screenX - canvasWidth / 2)
    const offsetY = -(screenY - canvasHeight / 2)

    this.centerX += offsetX * (oldMPP - newMPP)
    this.centerY += offsetY * (oldMPP - newMPP)
  }
}
