// ═══ Line twin isolation proof (browser side, #834 M5 slice 1) ═══
//
// Renders ONE synthetic line segment through the REAL line Material twins
// (emitLineWgsl WGSL authority / emitLineGlsl GLSL twin) on a scratch
// WebGl2Device — no VTR, no tile pipeline, no ring allocators. Identity MVP,
// mercator projType 0, camera at origin: the segment spans clip space
// horizontally, layer width 40px on a 64px canvas → a fat visible bar.
//
// PERMANENT REGRESSION PROOF for the autoVars/pre-pass ordering bug: running
// lowerStorageToDataTexture before autoVars orphaned every read of an
// assigned plain-value temp from its assignments (Expr object identity), so
// vs_line returned position = vec4(0) for every vertex — draws executed with
// zero GL errors and produced zero fragments. This harness caught it where
// the full-demo gate could only say "no pixels".

import { WebGl2Device, wrapWebGl2Pass } from '@xgis/rhi-webgl2'
import { Material, executeItems } from '@xgis/map'
import { emitLineWgsl } from '../../map/src/shaders/dsl/line'
import { emitLineGlsl } from '../../map/src/shaders/dsl/line-glsl'
import type { RhiBindLayoutEntry } from '@xgis/rhi'

export async function runLineProof(): Promise<{
  colored: number
  total: number
  glError: number
}> {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, stencil: true })!
  const rhi = new WebGl2Device(gl)

  const TILE_ENTRIES: RhiBindLayoutEntry[] = [
    { binding: 0, kind: 'uniform', dynamic: true, name: 'TileUniforms' },
  ]
  const LAYER_ENTRIES: RhiBindLayoutEntry[] = [
    { binding: 0, kind: 'uniform', dynamic: true, name: 'LineLayer' },
    { binding: 1, kind: 'storage', name: 'segments' },
    { binding: 2, kind: 'storage', name: 'shapes' },
    { binding: 3, kind: 'storage', name: 'shape_segments' },
  ]
  const mat = new Material(rhi, {
    shader: emitLineWgsl(false),
    vsEntry: 'vs_line',
    fsEntry: 'fs_line',
    vsCode: emitLineGlsl(false, 'vertex'),
    fsCode: emitLineGlsl(false, 'fragment'),
    format: 'rgba8unorm',
    sampleCount: 1,
    groups: [TILE_ENTRIES, LAYER_ENTRIES],
    colorTargets: [{ format: 'rgba8unorm', blend: 'alpha' }],
    variants: [{ depthWrite: false, depthCompare: 'less-equal', label: 'line-proof' }],
  })

  // ── TileUniforms (272 B std140) — identity mvp, mercator, camera at origin ──
  const tile = new Float32Array(272 / 4)
  tile.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0) // mvp @0
  // fill_color @64 / stroke_color @80 / proj_params @96 (projType 0 = mercator)
  // cam_h @112 / cam_l @120 / tile_origin_merc @128 all stay 0
  tile[34] = 1 // opacity @136
  tile[35] = 1 // log_depth_fc @140
  tile[38] = 1e7 // tile_extent_m @152
  tile.set([-1e30, 0, 0, 0], 40) // clip_bounds sentinel @160
  tile.set([0, 0, 0, 1], 52) // cam_ecef_off_h @208 (.w flag lane)
  tile.set([0, 0, 0, 1], 56) // cam_ecef_off_l @224
  tile.set([0, 0, 1, 0], 64) // globe_eye @256
  const tileBuf = rhi.createBuffer({ size: tile.byteLength, usage: 'uniform', label: 'proof-tile' })
  rhi.writeBuffer(tileBuf, 0, tile)

  // ── LineLayer (208 B std140) — magenta, 40 px wide ──
  const layer = new Float32Array(208 / 4)
  layer.set([1, 0, 1, 1], 0) // color = magenta
  layer[4] = 40 // width_px
  layer[5] = 1 // aa_width_px
  layer[6] = 1 // mpp
  layer[7] = 2 // miter_limit
  layer[45] = 64 // viewport_height @180
  layer[46] = 1 // dpr @184
  const layerBuf = rhi.createBuffer({
    size: layer.byteLength,
    usage: 'uniform',
    label: 'proof-layer',
  })
  rhi.writeBuffer(layerBuf, 0, layer)

  // ── One segment, stride 20 f32: horizontal span x −0.5 → +0.5 at y 0 ──
  const seg = new Float32Array(20)
  seg.set([-0.5, 0], 0) // p0_h
  seg.set([0.5, 0], 2) // p1_h
  seg.set([1, 0], 8) // prev_tangent
  seg.set([1, 0], 10) // next_tangent
  seg[13] = 1 // line_length
  const segBuf = rhi.createBuffer({ size: seg.byteLength, usage: 'storage', label: 'proof-seg' })
  rhi.writeBuffer(segBuf, 0, seg)
  const emptyShape = rhi.createBuffer({ size: 64, usage: 'storage', label: 'proof-shape' })
  rhi.writeBuffer(emptyShape, 0, new Float32Array(16))

  const tileBG = rhi.createBindGroup(mat.layout(0), [
    { binding: 0, resource: { buffer: tileBuf, offset: 0, size: tile.byteLength } },
  ])
  const layerBG = rhi.createBindGroup(mat.layout(1), [
    { binding: 0, resource: { buffer: layerBuf, offset: 0, size: layer.byteLength } },
    { binding: 1, resource: { buffer: segBuf } },
    { binding: 2, resource: { buffer: emptyShape } },
    { binding: 3, resource: { buffer: emptyShape } },
  ])

  gl.viewport(0, 0, 64, 64)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
  const pass = wrapWebGl2Pass(rhi)
  executeItems(mat, pass, [
    {
      variant: 0,
      bindGroups: [tileBG, layerBG],
      dynamicOffsets: [[0], [0]],
      count: 6,
      indexed: false,
      instanceCount: 1,
    },
  ])

  const px = new Uint8Array(64 * 64 * 4)
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px)
  let colored = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 60 || px[i + 1] > 60 || px[i + 2] > 60) colored++
  }
  return { colored, total: 64 * 64, glError: gl.getError() }
}
