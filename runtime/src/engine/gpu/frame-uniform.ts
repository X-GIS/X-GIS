// Shared frame uniform buffer.
//
// Before this service, every renderer (point, raster, line, vector-tile,
// background, …) maintained its OWN uniform buffer with its OWN copy of
// the same per-frame values: mvp matrix, projection type/center, viewport
// size, meters-per-pixel, log-depth FC. Each renderer wrote the same
// numbers to a separate GPU buffer every frame, and any renderer that
// called writeBuffer twice in a frame (e.g. point-renderer's
// flushTilePoints + render path both writing offset-0 of the shared
// uniformBuffer) was a latent dynamic-offset bug waiting to bite if
// anyone added a per-call differing field.
//
// `FrameUniform` centralises the writable state:
//   - one GPU buffer, one writeBuffer per frame
//   - the projection/view consts emitted into the shader stay in sync
//     across all consumers without per-renderer wiring
//   - new shared uniforms can be added in ONE place
//
// WGSL contract (mirror in every shader that binds this):
//
//   struct FrameUniform {
//     mvp: mat4x4<f32>,          // 0..63    — RTC MVP from Camera.getFrameView
//     proj_params: vec4<f32>,    // 64..79   — type, centerLon, centerLat, log_depth_fc
//     viewport: vec4<f32>,       // 80..95   — w_px, h_px, meters_per_pixel, dpr
//     _pad: vec4<f32>,           // 96..111  — reserved for future shared globals
//   }
//
// Total size: 112 bytes; rounded up to 128 for cache-line alignment.
// All writes go to offset 0 via a SINGLE writeBuffer per frame from
// `setFrame()`. Multi-call renderers (e.g. point-renderer flushing tile
// points then rendering direct layers) read the same already-written
// buffer — no risk of "last writeBuffer wins" stomping prior draws.

import type { Camera } from '../projection/camera'

export const FRAME_UNIFORM_SIZE_BYTES = 128

/** WGSL struct + binding declaration. Renderers paste this into their
 *  shader source so the byte layout stays version-locked with the CPU
 *  writer below. Replace `__FRAME_GROUP__` / `__FRAME_BINDING__` with
 *  the renderer's chosen group+binding indices when concatenating. */
export const WGSL_FRAME_UNIFORM = /* wgsl */`
struct FrameUniform {
  mvp: mat4x4<f32>,
  proj_params: vec4<f32>,   // x=type, y=centerLon, z=centerLat, w=log_depth_fc
  viewport: vec4<f32>,      // x=w_px, y=h_px, z=meters_per_pixel, w=dpr
  _pad: vec4<f32>,
}
`

export class FrameUniform {
  readonly buffer: GPUBuffer
  private readonly device: GPUDevice
  private readonly cpu = new Float32Array(FRAME_UNIFORM_SIZE_BYTES / 4)
  /** Monotonic frame counter to deduplicate writes within one frame.
   *  setFrame() is idempotent — calling it multiple times per frame with
   *  the same params skips the writeBuffer. */
  private writtenFrame = -1

  constructor(device: GPUDevice) {
    this.device = device
    this.buffer = device.createBuffer({
      size: FRAME_UNIFORM_SIZE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'frame-uniform',
    })
  }

  /** Compute meters-per-pixel at the camera's current zoom. Mirrors the
   *  WORLD_MERC / TILE_PX / 2^zoom formula every renderer already had. */
  private static metersPerPixel(zoom: number): number {
    const WORLD_MERC = 40075016.686
    const TILE_PX = 512
    return (WORLD_MERC / TILE_PX) / Math.pow(2, zoom)
  }

  /** Write the per-frame uniform to GPU. Call once per frame from the
   *  map's render loop BEFORE any pass that needs `mvp` / `proj_params`
   *  / `viewport`. Subsequent calls in the same `frameTag` are no-ops. */
  setFrame(
    frameTag: number,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    if (frameTag === this.writtenFrame) return
    const frame = camera.getFrameView(canvasWidth, canvasHeight, dpr)
    const u = this.cpu
    u.set(frame.matrix, 0)
    u[16] = projType
    u[17] = projCenterLon
    u[18] = projCenterLat
    u[19] = frame.logDepthFc
    u[20] = canvasWidth
    u[21] = canvasHeight
    u[22] = FrameUniform.metersPerPixel(camera.zoom)
    u[23] = dpr
    // pad slots 24..27 stay zero (declared but unused — leaves headroom
    // for future shared globals without rebinding every renderer).
    this.device.queue.writeBuffer(this.buffer, 0, u.buffer, u.byteOffset, FRAME_UNIFORM_SIZE_BYTES)
    this.writtenFrame = frameTag
  }

  destroy(): void {
    this.buffer.destroy()
  }
}
