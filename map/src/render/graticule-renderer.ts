// ═══ GraticuleRenderer — lat/lon grid overlay ═══
//
// Extracted VERBATIM from MapRenderer (renderer.ts) — the graticule overlay
// is an orthogonal decoration that owns its own GPU-buffer lifecycle +
// zoom-bucket regeneration + WeakMap cache, and only borrows the layer
// path's `linePipeline` + base `bindGroup` + `UniformRing` per frame (passed
// in as call arguments — this collaborator holds NO MapRenderer
// back-reference).
//
// DO-NOT-SPLIT (renderer-decomposition-2026-06-09 §6 #1): the per-frame
// uniform write uses the SAME 240-byte std140 struct offsets as the layer
// path. The packed frame values (mvp / logDepthFc / proj_params / zoom) are
// PASSED IN; the offsets are NOT re-derived or changed.

import type { GPUContext } from '@xgis/engine'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import { generateGraticule } from '../graticule'
import type { UniformRing } from './uniform-ring'
import { polygonU as POLYGON_U } from '../shaders/dsl/polygon'
import { globeEyeUniform } from './globe-eye-uniform'

// Typed pack target for the shared polygon 'Uniforms' struct (#733 P2c) — layout
// from wgslLayout(U.struct), module-free, so constructing it never triggers the
// projection emit; write() is typed by the same field record the WGSL is emitted
// from (completeness compile-time — the #600 globe_eye class does not compile).
// LAZY memo (draw time), same discipline as the reflect() slots it replaces.
let _gratBlock: UniformBlockOf<typeof POLYGON_U> | null = null
function gratBlock(): UniformBlockOf<typeof POLYGON_U> {
  return (_gratBlock ??= uniformBlock(POLYGON_U))
}

/** Per-frame data the graticule draw needs from the coordinator. The
 *  graticule reuses the SAME 240-byte uniform struct offsets as the layer
 *  path — these are the packed values written at those offsets, never
 *  re-derived here. */
export interface GraticuleFrame {
  /** ECEF-MVP (frame.matrix) — written at byte 0. */
  mvp: Float32Array | number[]
  /** frame.logDepthFc — written at byte 140 (offset 128, slot 3). */
  logDepthFc: number
  /** proj_params.x — written at byte 96. */
  projType: number
  /** proj_params.y — written at byte 100. */
  projCenterLon: number
  /** proj_params.z — written at byte 104. */
  projCenterLat: number
  /** camera.zoom — drives zoom-bucket regeneration. */
  zoom: number
  /** #600 — absolute sphere-ECEF camera position (frame.eye) for the globe(7)
   *  eye-horizon cull, written into the globe_eye slot. Undefined off the globe
   *  (flat/disc cull arms ignore it). */
  eye?: readonly [number, number, number]
}

export class GraticuleRenderer {
  // Polygon Uniforms struct byte size is read LAZILY at draw time via
  // polygonUniformBytes() (memoised) — see drawGraticule below. It is derived
  // from reflect() so it tracks the struct automatically (the borrowed
  // linePipeline's shader references u up to the last field, so the bound range
  // must cover the full struct size; RTC fields + light_dir_ecef stay zero —
  // graticule lines never extrude).
  // MUST stay lazy: polygonUniformBytes() → polygonUniformSlots() →
  // reflect(buildPolygonModule) EMITS the projection fns, which throws until
  // configureProjections() has run (post-GPU-init). A `static readonly` field
  // evaluates at class-definition (import) time — before configureProjections —
  // and crashed the entire map init ("configureProjections() must be called
  // before any projection emit"); the map never left "Initializing…".

  private graticuleBuffer: GPUBuffer | null = null
  private graticuleVertexCount = 0
  private lastGratZoom = -1
  /** Toggle for the lat/lon grid overlay. Default OFF — the graticule
   *  was a dev/debug aid that shipped enabled; basemap-quality output
   *  should opt in. XGISMap exposes `setGraticuleEnabled()` so the
   *  host app + URL flags can flip it without rebuilding renderers. */
  private graticuleEnabled = false
  /** GPU-buffer cache mirroring graticule.ts's CPU-data cache.
   *  Keyed by GraticuleData IDENTITY — the underlying generator
   *  returns the same object for the same zoom bucket, so a Map
   *  keyed by reference avoids recomputing a bucket key here.
   *
   *  10 ms / call on Bright zoom animations (createBuffer +
   *  writeBuffer + destroy) fired exactly on LOD-boundary frames,
   *  doubling the worst-frame hitch. With this cache, re-entry into
   *  a previously-seen bucket is a pointer swap (~0 ms). */
  private graticuleBufferCache = new WeakMap<object, { buf: GPUBuffer; count: number }>()

  constructor(private readonly ctx: GPUContext) {}

  /** Toggle the lat/lon grid overlay at runtime. Default off. */
  setEnabled(on: boolean): void {
    this.graticuleEnabled = on
    if (on && !this.graticuleBuffer) this.initGraticule(this.lastGratZoom >= 0 ? this.lastGratZoom : 2)
  }

  /** Read the current graticule on/off state. */
  isEnabled(): boolean {
    return this.graticuleEnabled
  }

  /** Current graticule index/vertex count (for getDrawStats). */
  vertexCount(): number {
    return this.graticuleVertexCount
  }

  private initGraticule(zoom = 2): void {
    const grat = generateGraticule(zoom)
    // Same GraticuleData reference → same bucket as last call →
    // GPU buffer is already correct, no need to destroy/create/upload.
    const cached = this.graticuleBufferCache.get(grat)
    if (cached) {
      this.graticuleBuffer = cached.buf
      this.graticuleVertexCount = cached.count
      this.lastGratZoom = zoom
      return
    }
    // Don't destroy the previous buffer — it's still referenced by
    // a cached entry for its own bucket. The WeakMap holds references
    // alive while their bucket is reachable; when graticule.ts's
    // bucket cache evicts (currently never), the GraticuleData object
    // becomes unreachable and the WeakMap entry GCs along with the
    // GPUBuffer.
    const buf = this.ctx.device.createBuffer({
      size: grat.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'graticule',
    })
    this.ctx.device.queue.writeBuffer(buf, 0, grat.vertices)
    this.graticuleBufferCache.set(grat, { buf, count: grat.indexCount })
    this.graticuleBuffer = buf
    this.graticuleVertexCount = grat.indexCount
    this.lastGratZoom = zoom
  }

  /**
   * Draw the graticule grid (or no-op when disabled). Called by MapRenderer
   * at the SAME point in renderToPass — after the layer draws — with the
   * borrowed `linePipeline` + base `bindGroup` + `UniformRing` + the packed
   * frame data. The buffer is regenerated only on a zoom-bucket change.
   */
  renderFrame(
    pass: GPURenderPassEncoder,
    linePipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    ring: UniformRing,
    frame: GraticuleFrame,
  ): void {
    // Regenerate graticule if zoom level changed (adaptive spacing).
    // Skip entirely when disabled so the GPU buffer + writeBuffer
    // churn stays out of the hot path for default-off basemaps.
    if (this.graticuleEnabled) {
      const gratZoom = Math.round(frame.zoom)
      if (gratZoom !== this.lastGratZoom) {
        this.initGraticule(gratZoom)
      }
    }

    // Draw graticule grid lines (primary world + copies)
    // Each world copy needs its own uniform buffer (WebGPU batches writeBuffer)
    if (this.graticuleEnabled && this.graticuleBuffer) {
      pass.setPipeline(linePipeline)
      pass.setVertexBuffer(0, this.graticuleBuffer)

      // PR 2d.1D: graticule vertices are absolute ECEF — no per-copy camera
      // shift needed. Draw once per frame (ECEF world-copy = same geometry).
      // Previously iterated worldCopiesFor(projType) for Mercator cam_h shift.
      for (let wi = 0; wi < 1; wi++) {
        // Full-struct typed pack (#733 P2c) — the SAME polygon 'Uniforms' struct
        // as the layer path, every field named, completeness compile-time.
        // Graticule vertices are ECEF-encoded (PR 2d.1D): RTC anchor = (0,0,0)
        // (absolute ECEF, no per-tile centering), cam_h/cam_l unused by vs_main,
        // RTC/extrude/light fields zero (graticule lines never extrude),
        // pick_id = 0 (decorative, never pickable), clip_bounds = the "no clip"
        // sentinel (same rationale as the polygon path). globe_eye derives from
        // frame.eye (#600) — undefined off the globe → all-zero, ignored by the
        // flat/disc cull arms.
        const B = gratBlock()
        const ge = globeEyeUniform(frame.eye)
        B.write({
          mvp: frame.mvp, // ECEF-MVP for vs_main
          fill_color: [1, 1, 1, 0.15],   // white @ 15% (minor grid line colour)
          stroke_color: [1, 1, 1, 0.15],
          proj_params: [frame.projType, frame.projCenterLon, frame.projCenterLat, 0],
          cam_h: [0, 0], cam_l: [0, 0],
          tile_origin_merc: [0, 0],
          opacity: 1,
          log_depth_fc: frame.logDepthFc,
          pick_id: 0, layer_depth_offset: 0, tile_extent_m: 0, extrude_height_m: 0,
          clip_bounds: [-1e30, 0, 0, 0],
          zoom: 0, extrude_base_m: 0, fill_translate_x: 0, fill_translate_y: 0,
          tile_dequant_scale: 0, tile_dequant_half: 0,
          light_color_packed: 0, _pad_light_align: 0,
          cam_ecef_off_h: [0, 0, 0, 0], cam_ecef_off_l: [0, 0, 0, 0],
          light_dir_ecef: [0, 0, 0, 0],
          globe_eye: [ge[0], ge[1], ge[2], ge[3]],
        })
        const gratOff = ring.allocSlot()
        ring.stageSlot(gratOff, B.buffer)

        pass.setBindGroup(0, bindGroup, [gratOff])
        pass.draw(this.graticuleVertexCount)
      }
    }
  }
}
