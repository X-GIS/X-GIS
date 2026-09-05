// ═══ Fullscreen compose / blur pipeline builders ═══
//
// Extracted verbatim from PipelineFactory (the file was at its size-ratchet ceiling). These three
// single-sample fullscreen pipelines — overdraw-debug compose, heatmap separable-Gaussian blur, and
// heatmap colour-ramp compose — share nothing with the per-tile fill/line pipelines, so they live in
// their own module. Each returns { pipeline, layout }; the factory's ensure* wrappers keep the lazy
// memoization + assign the bind-group layout the renderer reads back.

import { BLEND_ALPHA } from '@xgis/rhi-webgpu'
import { emitOverdrawComposeWgsl } from '@xgis/engine'
import { emitOitComposeWgsl } from '../shaders/dsl/oit-compose'
import { oitComposeWgslId } from '../shaders/baked/ids'
import { bakedWgsl } from './material/wgsl-for'

interface BuiltPipeline {
  pipeline: GPURenderPipeline
  layout: GPUBindGroupLayout
}

/** Weighted-Blended OIT compose: a fullscreen triangle samples the accum (rgba16float) + revealage
 *  (r16float) targets and over-blends the recovered translucent colour onto the resolved swapchain.
 *  MSAA-aware (the targets are multisampled when sampleCount > 1; the shader averages every sample). */
export function buildOitComposePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
): BuiltPipeline {
  const isMsaa = sampleCount > 1
  // #2499 — `wgsl/oit-compose/s<n>` is baked for every `QUALITY.msaa` count; the store first,
  // the emit on a miss. `sampleCount` is the one value driving the id and the emit (isMsaa
  // is derived from it here exactly as the registry derives it).
  const module = device.createShaderModule({
    code: bakedWgsl(() => emitOitComposeWgsl(sampleCount, isMsaa), oitComposeWgslId(sampleCount)),
    label: 'oit-compose',
  })
  const layout = device.createBindGroupLayout({
    label: 'oit-compose-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', multisampled: isMsaa },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', multisampled: isMsaa },
      },
    ],
  })
  const pipeline = device.createRenderPipeline({
    label: 'oit-compose-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_full' },
    fragment: { module, entryPoint: 'fs_compose', targets: [{ format, blend: BLEND_ALPHA }] },
    primitive: { topology: 'triangle-list' },
    multisample: { count: sampleCount },
  })
  return { pipeline, layout }
}

/** Overdraw-debug compose: samples the r16float overdraw counter (unfilterable-float, no sampler)
 *  and tonemaps it to the swapchain. Single-sample (the debug pass turns MSAA off). */
export function buildOverdrawComposePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): BuiltPipeline {
  const module = device.createShaderModule({
    code: emitOverdrawComposeWgsl(),
    label: 'overdraw-compose-shader',
  })
  const layout = device.createBindGroupLayout({
    label: 'overdraw-compose-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', multisampled: false },
      },
    ],
  })
  const pipeline = device.createRenderPipeline({
    label: 'overdraw-compose-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_full' },
    fragment: { module, entryPoint: 'fs_compose', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  })
  return { pipeline, layout }
}

// (The heatmap blur/compose pipelines moved behind the RHI drapers in
// material/heatmap-material.ts — one Material per stage drives BOTH frame
// shapes, #1046 F3b Inc-2c. The WGSL here and there was already the same
// shader-dsl emit; only the native pipeline plumbing was duplicated.)
