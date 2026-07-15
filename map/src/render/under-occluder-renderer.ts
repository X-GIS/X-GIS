// ═══ Under-Occluder Renderer — INC-1 opaque depth-writing globe sphere ═══
//
// Draws one opaque solid-colour sphere seated JUST UNDER EARTH_R, depth-writing,
// BEFORE the globe vector pass (injected in the opaque pass, after raster, ahead
// of the vector shows). Purpose (design INC-1, nonmerc-vector-direct-reprojection):
//   • a hard, non-faded opaque BACKING so a residual T-junction / cross-LOD crack
//     in the vector fills bleeds to the SPHERE colour, not the void / far side;
//   • a DEPTH floor so far-hemisphere depth-testing geometry (future direct-drawn
//     extrusions / points) is occluded at the limb once the drape is retired.
// On the direct path TODAY the polygon eye-horizon cull (#600) already closes the
// visible fill limb, so this is a robustness / future-prep floor, not a visible fix.
//
// GLOBE (projType 7) ONLY — the caller gates it, so mercator / flat / disc emit no
// draw and stay byte-identical. The disc projTypes {3,4,5} reproject from the
// flat_rel DEGREE arm (not the ECEF lanes) and need a separate plane occluder
// (design INC-6), out of INC-1 scope.
//
// Engine-RHI only (Material / executeItems) — no raw WebGPU (map RHI-only rule).
// Mirrors RasterDraper's construction; the sphere VS/FS reuse the polygon eye-
// horizon cull + rim + log-depth so the occluder z-registers with the vector fills.

import type { RhiDevice, RhiBuffer, RhiBindGroup } from '@xgis/engine'
import {
  Material,
  executeItems,
  uniformBlock,
  isPickEnabled,
  type UniformBlockOf,
} from '@xgis/engine'
// wrapWebGpuPass: the opaque pass hands a NATIVE GPURenderPassEncoder; a Material /
// executeItems draw must bridge it to an RhiRenderPass — the SAME gap-blocked pattern
// raster-renderer / vector-drape-renderer / line-renderer carry until #991 P6 makes
// the pass chain hand a neutral RhiRenderPass. The opaque chain is WebGPU-only today
// (WebGL2 renders via render-loop.ts renderFrameViaRhi), so no backend branch is needed.
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import { emitGlslModule } from '@xgis/shader-dsl'
import { isGlobeProj } from '@xgis/geo'
import { lonLatToECEF } from '@xgis/shared'
import type { Camera } from '../camera'
import {
  emitUnderOccluderWgsl,
  buildUnderOccluderModule,
  underOccluderU as OCC_U,
} from '../shaders/dsl/under-occluder'
import { rasterGlobeCamAnchor } from './raster-renderer'
import { globeEyeUniform } from './globe-eye-uniform'

// Sphere mesh density — matches the synthetic earth-surface fill (128×64), whose
// silhouette this occluder sits just inside; 360/128 = 2.8° lon step keeps the
// limb sub-pixel-smooth on a full-canvas disc.
const WIDTH_SEGMENTS = 128
const HEIGHT_SEGMENTS = 64
// Inward radial bias: seat the sphere at (1−ε)·radius so it sits BEHIND the real
// vector fills at EARTH_R (they win the depth-`less-equal` test → no z-fight) and
// its silhouette is just inside the fill limb (no colour ring past the true limb).
// ε = 1e-3 → ~6.4 km under a 6371 km sphere: a 0.1 % radial inset (sub-pixel disc
// shrink at every practical zoom) yet far larger than the globe-distance log-depth
// resolution, so the ordering is unambiguous.
export const UNDER_OCCLUDER_RADIUS_SCALE = 1 - 1e-3
const RADIUS_SCALE = UNDER_OCCLUDER_RADIUS_SCALE

/** Build the interleaved sphere mesh: per vertex [ecefX, ecefY, ecefZ, lon, lat],
 *  ECEF pre-scaled to (1−ε)·radius. A degenerate lon/lat grid over ±180 × ±90
 *  (poles collapse to a single ECEF point — the VS handles the fan). Exported
 *  for the seat/pole regression test. */
export function buildUnderOccluderMesh(): { vertices: Float32Array; indices: Uint32Array } {
  const cols = WIDTH_SEGMENTS + 1
  const rows = HEIGHT_SEGMENTS + 1
  const vertices = new Float32Array(cols * rows * 5)
  let v = 0
  for (let y = 0; y < rows; y++) {
    const lat = -90 + (180 * y) / HEIGHT_SEGMENTS
    for (let x = 0; x < cols; x++) {
      const lon = -180 + (360 * x) / WIDTH_SEGMENTS
      const [ex, ey, ez] = lonLatToECEF(lon, lat)
      vertices[v++] = ex * RADIUS_SCALE
      vertices[v++] = ey * RADIUS_SCALE
      vertices[v++] = ez * RADIUS_SCALE
      vertices[v++] = lon
      vertices[v++] = lat
    }
  }
  const indices = new Uint32Array(WIDTH_SEGMENTS * HEIGHT_SEGMENTS * 6)
  let off = 0
  for (let y = 0; y < HEIGHT_SEGMENTS; y++) {
    for (let x = 0; x < WIDTH_SEGMENTS; x++) {
      const a = y * cols + x
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices[off++] = a
      indices[off++] = b
      indices[off++] = c
      indices[off++] = b
      indices[off++] = d
      indices[off++] = c
    }
  }
  return { vertices, indices }
}

export class UnderOccluderRenderer {
  private readonly material: Material
  private _pickMaterial?: Material
  private readonly block: UniformBlockOf<typeof OCC_U>
  private readonly vertexBuffer: RhiBuffer
  private readonly indexBuffer: RhiBuffer
  private readonly indexCount: number
  private readonly bgByMaterial = new Map<Material, RhiBindGroup>()
  private color: [number, number, number, number] = [0, 0, 0, 1]

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    this.material = this.buildMaterial(false)
    this.block = uniformBlock(OCC_U)
    const mesh = buildUnderOccluderMesh()
    this.indexCount = mesh.indices.length
    this.vertexBuffer = rhi.createBuffer({
      size: mesh.vertices.byteLength,
      usage: 'vertex',
      writable: true,
      label: 'under-occluder-vertices',
    })
    rhi.writeBuffer(this.vertexBuffer, 0, mesh.vertices)
    this.indexBuffer = rhi.createBuffer({
      size: mesh.indices.byteLength,
      usage: 'index',
      writable: true,
      label: 'under-occluder-indices',
    })
    rhi.writeBuffer(this.indexBuffer, 0, mesh.indices)
  }

  private buildMaterial(pickEnabled: boolean): Material {
    const mod = buildUnderOccluderModule(pickEnabled)
    return new Material(this.rhi, {
      shader: emitUnderOccluderWgsl(pickEnabled),
      vsEntry: 'vs_occluder',
      fsEntry: 'fs_occluder',
      vsCode: emitGlslModule(mod, 'vertex'),
      fsCode: emitGlslModule(mod, 'fragment'),
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [[{ binding: 0, kind: 'uniform' }]],
      // Interleaved [ecefX, ecefY, ecefZ, lon, lat] — vec3 @loc0, vec2 @loc1.
      vertexBuffers: [
        {
          stride: 5 * 4,
          attributes: [
            { location: 0, offset: 0, format: 'float32x3' },
            { location: 1, offset: 12, format: 'float32x2' },
          ],
        },
      ],
      colorTargets: pickEnabled
        ? [{ format: this.format as 'bgra8unorm', blend: 'alpha' }, { format: 'rg32uint' }]
        : [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      // Opaque, depth-WRITE, cull the far hemisphere (near-hemisphere front faces
      // only). less-equal so a real fill at EARTH_R (nearer) wins the depth test.
      cullMode: 'back',
      variants: [{ depthWrite: true, depthCompare: 'less-equal', label: 'under-occluder-rhi' }],
      globalUniformSize: 128, // mat4(64) + 4×vec4(64)
    })
  }

  private pickMat(): Material {
    return (this._pickMaterial ??= this.buildMaterial(true))
  }

  /** Update the sphere colour (the resolved style background fill, straight-alpha
   *  unit floats). Called on setBackgroundFill; cheap, stored for the next frame. */
  setColor(rgba: readonly [number, number, number, number]): void {
    this.color = [rgba[0], rgba[1], rgba[2], rgba[3]]
  }

  private globalBG(material: Material): RhiBindGroup {
    let bg = this.bgByMaterial.get(material)
    if (!bg) {
      bg = this.rhi.createBindGroup(material.layout(0), [
        { binding: 0, resource: { buffer: material.globalUniform! } },
      ])
      this.bgByMaterial.set(material, bg)
    }
    return bg
  }

  /** Draw the occluder sphere. Caller MUST gate to globe (projType 7) so flat /
   *  disc paths stay byte-identical. `w`/`h`/`dpr` size the camera frame. */
  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    centerLon: number,
    centerLat: number,
    w: number,
    h: number,
    dpr: number,
  ): void {
    // Globe (projType 7) only — dispatch via the projections-table membership
    // accessor (#996), never a raw `projType === 7`. Disc {3,4,5} reproject from
    // degrees (flat_rel) and are not seated by an ECEF sphere — separate work.
    if (!isGlobeProj(projType)) return
    const rhiPass = wrapWebGpuPass(pass)
    const frame = camera.getViewForProjection(projType, w, h, dpr)
    const anchor = rasterGlobeCamAnchor(centerLon, centerLat)
    const ge = globeEyeUniform(frame.eye)
    this.block.write({
      mvp: frame.matrix,
      proj_params: [projType, centerLon, centerLat, frame.logDepthFc],
      cam_ecef_center: [anchor[0], anchor[1], anchor[2], 0],
      globe_eye: [ge[0], ge[1], ge[2], ge[3]],
      color: this.color,
    })
    const pick = isPickEnabled()
    const material = pick ? this.pickMat() : this.material
    material.writeGlobal(this.block.buffer)
    executeItems(material, rhiPass, [
      {
        variant: 0,
        bindGroups: [this.globalBG(material)],
        vertex: this.vertexBuffer,
        index: { buffer: this.indexBuffer, format: 'uint32' },
        count: this.indexCount,
        indexed: true,
      },
    ])
  }

  destroy(): void {
    this.rhi.destroyBuffer(this.vertexBuffer)
    this.rhi.destroyBuffer(this.indexBuffer)
  }
}
