// ═══ Fullscreen compose / blur pipeline builders ═══
//
// Extracted verbatim from PipelineFactory (the file was at its size-ratchet ceiling). These three
// single-sample fullscreen pipelines — overdraw-debug compose, heatmap separable-Gaussian blur, and
// heatmap colour-ramp compose — share nothing with the per-tile fill/line pipelines, so they live in
// their own module. Each returns { pipeline, layout }; the factory's ensure* wrappers keep the lazy
// memoization + assign the bind-group layout the renderer reads back.

import { HEATMAP_DENSITY_FORMAT, BLEND_ALPHA } from '@xgis/engine'
import { emitOverdrawComposeWgsl } from '@xgis/engine'
import { emitHeatmapBlurWgsl } from '../shaders/dsl/heatmap-blur'
import { emitHeatmapComposeWgsl } from '../shaders/dsl/heatmap-compose'
import { emitOitComposeWgsl } from '../shaders/dsl/oit-compose'

interface BuiltPipeline { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }

/** Weighted-Blended OIT compose: a fullscreen triangle samples the accum (rgba16float) + revealage
 *  (r16float) targets and over-blends the recovered translucent colour onto the resolved swapchain.
 *  MSAA-aware (the targets are multisampled when sampleCount > 1; the shader averages every sample). */
export function buildOitComposePipeline(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): BuiltPipeline {
  const isMsaa = sampleCount > 1
  const module = device.createShaderModule({ code: emitOitComposeWgsl(sampleCount, isMsaa), label: 'oit-compose' })
  const layout = device.createBindGroupLayout({
    label: 'oit-compose-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', multisampled: isMsaa } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', multisampled: isMsaa } },
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
export function buildOverdrawComposePipeline(device: GPUDevice, format: GPUTextureFormat): BuiltPipeline {
  const module = device.createShaderModule({ code: emitOverdrawComposeWgsl(), label: 'overdraw-compose-shader' })
  const layout = device.createBindGroupLayout({
    label: 'overdraw-compose-bgl',
    entries: [{
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'unfilterable-float', multisampled: false },
    }],
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

/** Heatmap separable-Gaussian blur: fullscreen triangle samples the r16float density via textureLoad
 *  and writes the 9-tap blur to an r16float target. The `direction` uniform selects H vs V. */
export function buildHeatmapBlurPipeline(device: GPUDevice): BuiltPipeline {
  const module = device.createShaderModule({ code: emitHeatmapBlurWgsl(), label: 'heatmap-blur-shader' })
  const layout = device.createBindGroupLayout({
    label: 'heatmap-blur-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  })
  const pipeline = device.createRenderPipeline({
    label: 'heatmap-blur-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_full' },
    fragment: { module, entryPoint: 'fs_blur', targets: [{ format: HEATMAP_DENSITY_FORMAT }] },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  })
  return { pipeline, layout }
}

/** Heatmap compose: samples the blurred density (textureLoad), maps it through the colour-ramp LUT
 *  (filterable rgba8, textureSample) × intensity × opacity, alpha-blended over the resolved swapchain. */
export function buildHeatmapComposePipeline(device: GPUDevice, format: GPUTextureFormat): BuiltPipeline {
  const module = device.createShaderModule({ code: emitHeatmapComposeWgsl(), label: 'heatmap-compose-shader' })
  const layout = device.createBindGroupLayout({
    label: 'heatmap-compose-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', multisampled: false } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  })
  const pipeline = device.createRenderPipeline({
    label: 'heatmap-compose-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_full' },
    fragment: {
      module, entryPoint: 'fs_compose',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  })
  return { pipeline, layout }
}
