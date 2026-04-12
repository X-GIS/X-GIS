// ═══ 2D Map Camera — 줌/패닝 ═══

import { lonLatToMercator } from '../loader/geojson'

export class Camera {
  /** Camera center in Web Mercator coordinates */
  centerX: number
  centerY: number
  /** Zoom level (0 = whole world, higher = closer) */
  zoom: number
  /** Map rotation in degrees (0 = north up, clockwise positive) */
  bearing = 0
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

  // Preallocated RTC matrix (reused every frame)
  private rtcMatrix = new Float32Array(16)

  /** RTC matrix: scale + rotation, no translation (RTC vertex shader already centered) */
  getRTCMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const scaleX = 2 / (canvasWidth * metersPerPixel)
    const scaleY = 2 / (canvasHeight * metersPerPixel)

    const rad = -this.bearing * Math.PI / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    const m = this.rtcMatrix
    m[0] = scaleX * cos;  m[1] = scaleX * sin;  m[2] = 0; m[3] = 0
    m[4] = -scaleY * sin; m[5] = scaleY * cos;  m[6] = 0; m[7] = 0
    m[8] = 0;             m[9] = 0;             m[10] = 1; m[11] = 0
    m[12] = 0;            m[13] = 0;            m[14] = 0; m[15] = 1
    return m
  }

  // Mercator Y limit: ±85.051129° → ±20037508.34m
  private static readonly MAX_Y = 20037508.34

  /** Compute the maximum camera Y offset for the current zoom (content stays on screen) */
  private maxCameraY(canvasHeight: number): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const visibleHalf = (canvasHeight / dpr) * metersPerPixel / 2
    // Camera can move until the Mercator edge reaches the screen edge
    return Math.max(0, Camera.MAX_Y - visibleHalf)
  }

  /** Pan by CSS pixels (clientX/clientY delta), accounting for map rotation */
  pan(dx: number, dy: number, canvasWidth: number, canvasHeight: number): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const metersPerPhysicalPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const metersPerCSSPixel = metersPerPhysicalPixel * dpr

    // Rotate screen delta by bearing to get map-space delta
    const rad = this.bearing * Math.PI / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const mapDx = dx * cos + dy * sin
    const mapDy = -dx * sin + dy * cos

    this.centerX -= mapDx * metersPerCSSPixel
    const maxY = this.maxCameraY(canvasHeight)
    const newY = this.centerY + mapDy * metersPerCSSPixel
    this.centerY = Math.max(-maxY, Math.min(maxY, newY))
  }

  /** Rotate by delta degrees */
  rotate(deltaDeg: number): void {
    this.bearing = ((this.bearing + deltaDeg) % 360 + 360) % 360
  }

  /** Reset bearing to north-up */
  resetBearing(): void {
    this.bearing = 0
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
    // Clamp after zoom: visible area changes with zoom level
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
  }
}
