// Shared frame uniform buffer — SCHEMA owned by @xgis/map, packed through the
// engine's UniformBlock mechanism (#991 P0 0.1/0.5).
//
// Before this service, every renderer (point, raster, line, vector-tile,
// background, …) maintained its OWN uniform buffer with its OWN copy of
// the same per-frame values: mvp matrix, projection type/center, viewport
// size, meters-per-pixel, log-depth FC. Each renderer wrote the same
// numbers to a separate GPU buffer every frame.
//
// `FrameUniform` centralises the writable state:
//   - one GPU buffer, one writeBuffer per frame
//   - the projection/view consts emitted into the shader stay in sync
//     across all consumers without per-renderer wiring
//   - new shared uniforms can be added in ONE place
//
// SINGLE LAYOUT AUTHORITY (#991 P0). The frame-uniform layout is content —
// `proj_params` (projection type/center) and `viewport.z` (meters-per-pixel,
// a Mercator-scale quantity) are map concepts, so the SCHEMA lives here, in the
// content layer, NOT in the content-blind engine. The DSL `frameU` struct below
// is the sole layout authority: the CPU packs THROUGH `UniformBlock.of(frameU)`
// (completeness enforced by tsc — a missing field is a compile error, the #600
// globe_eye class), retiring the old hand-locked `u[16] = …` byte-lane writes.
// The engine keeps only the generic MECHANISM (`UniformBlock`); map owns the
// map-specific schema.
//
// WGSL contract (mirror in every shader that binds this):
//
//   struct FrameUniform {
//     mvp: mat4x4<f32>,          // 0..63    — Mercator-DSFUN MVP from Camera.getFrameView
//     proj_params: vec4<f32>,    // 64..79   — type, centerLon, centerLat, log_depth_fc
//     viewport: vec4<f32>,       // 80..95   — w_px, h_px, meters_per_pixel, dpr
//     _pad: vec4<f32>,           // 96..111  — reserved for future shared globals
//     _pad_cacheline: vec4<f32>, // 112..127 — pads the struct to a 128-byte cache line
//   }
//
// Total size: 128 bytes (the trailing `_pad_cacheline` lane rounds the 112-byte
// payload up to a cache line, in the STRUCT — previously the CPU buffer was
// hand-padded to 128, a byte-lane the DSL struct now owns explicitly). All writes
// go to offset 0 via a SINGLE writeBuffer per frame from `setFrame()`. Multi-call
// renderers read the same already-written buffer — no "last writeBuffer wins".
//
// Status (Phase 2 closeout): this class is currently DORMANT in production —
// every renderer instantiates its own Uniforms struct. The `setFrame` writer
// remains here as scaffolding for the eventual shared-uniform consolidation pass
// and continues to exercise the legacy `Camera.getFrameView()` (Mercator-DSFUN)
// entry point in tests. See `camera.ts` `getFrameView` JSDoc for the rationale.

import type { Camera } from '../camera'
import { EARTH } from '@xgis/shared'
import { uniformStruct, mat4x4fT, vec4fT, module, emitModule } from '@xgis/shader-dsl'
import { uniformBlock } from '@xgis/engine'

export const FRAME_UNIFORM_SIZE_BYTES = 128

// The frame-uniform SCHEMA — the sole layout authority (#991 P0 0.5). `viewport`
// carries the pixel size (x=w_px, y=h_px, w=dpr) plus the Mercator-scale
// meters-per-pixel (z), and `proj_params` the projection type/center — both map
// content, which is why this declaration lives in @xgis/map, not the engine.
export const frameU = uniformStruct(
  'FrameUniform',
  { group: 0, binding: 0, as: 'frame' },
  {
    mvp: mat4x4fT,
    proj_params: vec4fT,
    viewport: vec4fT,
    _pad: vec4fT,
    _pad_cacheline: vec4fT,
  },
)

/** WGSL struct declaration. Renderers paste this into their shader source so the
 *  byte layout stays version-locked with the CPU packer (now `UniformBlock`).
 *  Emitted from `frameU` — the SAME struct the CPU packs through, so the layout
 *  can no longer drift between the shader read and the CPU write (#991 P0). */
export const WGSL_FRAME_UNIFORM = emitModule(module({ structs: [frameU.struct] }))

export class FrameUniform {
  readonly buffer: GPUBuffer
  private readonly device: GPUDevice
  /** The typed std140 packer — the sole layout authority. `write({…})` demands
   *  every field (tsc-enforced completeness) and lays them out via the reflected
   *  `frameU` layout, so the packed bytes match the emitted WGSL by construction. */
  private readonly block = uniformBlock(frameU)
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
    const WORLD_MERC = EARTH.worldMerc
    const TILE_PX = 512
    return WORLD_MERC / TILE_PX / Math.pow(2, zoom)
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
    // Pack THROUGH the reflected layout — completeness is tsc-checked, so the
    // 128 bytes match the emitted `FrameUniform` struct by construction.
    this.block.write({
      mvp: frame.matrix,
      proj_params: [projType, projCenterLon, projCenterLat, frame.logDepthFc],
      viewport: [canvasWidth, canvasHeight, FrameUniform.metersPerPixel(camera.zoom), dpr],
      _pad: [0, 0, 0, 0],
      _pad_cacheline: [0, 0, 0, 0],
    })
    this.device.queue.writeBuffer(this.buffer, 0, this.block.buffer, 0, FRAME_UNIFORM_SIZE_BYTES)
    this.writtenFrame = frameTag
  }

  destroy(): void {
    this.buffer.destroy()
  }
}
