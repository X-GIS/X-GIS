// ═══ Backend-neutrality RATCHET — WebGPU types must not spread in the engine ═══
//
// The engine provides the backend-neutral RHI; WebGPU-NATIVE types (GPUDevice,
// GPUBuffer, …) belong ONLY inside the WebGPU backend adapter (rhi-webgpu.ts)
// and are a LEAK everywhere else — every leak forces the next backend into
// lies (the forcegl2 no-op Proxy device, `ctx.rhi as WebGpuDevice`, the
// GPUArena unwrapBuffer crash, #832). This test pins the CURRENT per-file
// leak counts and FAILS on any increase, so neutrality can only ratchet
// toward zero. When you REMOVE a usage, lower that file's baseline (or drop
// the entry at zero) in the same commit — that locks the win in.
//
// Counting rule: comments are stripped first (documenting WebGPU behaviour in
// prose is fine — it is TYPE/VALUE usage that couples), then occurrences of
// the explicit WebGPU API identifier list below are counted. Project-own
// names that merely start with "GPU" (GPUArena, GPUContext, GPUTile…) are NOT
// WebGPU types and are not counted.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(import.meta.url), '..')

/** The ONLY engine module allowed to speak WebGPU: the backend adapter. */
const EXEMPT = new Set(['render/rhi/rhi-webgpu.ts'])

/** Explicit WebGPU API identifiers (types, enums, namespaces, globals). */
const WEBGPU_IDENT =
  /\bGPU(?:Device|Buffer|BufferUsage|BufferDescriptor|Texture|TextureView|TextureUsage|TextureFormat|TextureDescriptor|Sampler|SamplerDescriptor|BindGroup|BindGroupLayout|BindGroupEntry|BindGroupDescriptor|BindGroupLayoutEntry|BindGroupLayoutDescriptor|RenderPipeline|RenderPipelineDescriptor|ComputePipeline|ComputePipelineDescriptor|RenderPassEncoder|RenderPassDescriptor|RenderPassColorAttachment|RenderPassDepthStencilAttachment|RenderBundle|RenderBundleEncoder|RenderBundleEncoderDescriptor|ComputePassEncoder|ComputePassDescriptor|CommandEncoder|CommandBuffer|Queue|CanvasContext|Adapter|ShaderModule|ShaderStage|VertexBufferLayout|VertexAttribute|VertexFormat|VertexState|FragmentState|ColorTargetState|BlendState|DepthStencilState|StencilFaceState|PrimitiveState|MultisampleState|PipelineLayout|PipelineLayoutDescriptor|ColorWrite|MapMode|IndexFormat|CullMode|CompareFunction|LoadOp|StoreOp|FilterMode|AddressMode|FeatureName|QuerySet|QuerySetDescriptor|DeviceLostInfo|Error|UncapturedErrorEvent|ValidationError|OutOfMemoryError|Origin3D|Extent3D|ColorDict|Color)\b|\bnavigator\.gpu\b/g

/** Pinned per-file counts (2026-07 baseline, #832). ONLY DECREASE these. */
const BASELINE: ReadonlyMap<string, number> = new Map([
  ['gpu/bind-tiers.ts', 23],
  ['gpu/compute.ts', 34],
  ['gpu/frame-uniform.ts', 5],
  ['gpu/gpu-shared.ts', 19],
  ['gpu/gpu-timer.ts', 16],
  ['gpu/gpu.ts', 22],
  ['gpu/palette-texture.ts', 10],
  ['gpu/staging-buffer-pool.ts', 10],
  ['render/bundle-cache.ts', 12],
  ['render/compute-bind-layout.ts', 10],
  ['render/frame-context.ts', 4],
  ['render/reflection-to-webgpu.ts', 8],
  ['render/render-targets.ts', 39],
  ['render/vertex-buffer-layout.ts', 3],
])

/** Strip block + line comments (naive but sufficient: the engine has no
 *  template literals containing `/*` next to WebGPU identifiers). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* tsFiles(p)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) yield p
  }
}

describe('engine backend-neutrality ratchet (#832)', () => {
  it('WebGPU API identifiers appear only in rhi-webgpu.ts or at/below the pinned baseline', () => {
    const over: string[] = []
    const improved: string[] = []
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/')
      if (EXEMPT.has(rel)) continue
      const count = (stripComments(readFileSync(file, 'utf8')).match(WEBGPU_IDENT) ?? []).length
      const pinned = BASELINE.get(rel) ?? 0
      if (count > pinned) over.push(`${rel}: ${count} WebGPU identifiers (baseline ${pinned})`)
      else if (count < pinned) improved.push(`${rel}: ${count} < baseline ${pinned}`)
    }
    if (improved.length > 0) {
      // Not a failure — but lock the win in: lower the baseline in this file.
      console.log(
        `[neutrality-ratchet] leaks REDUCED — lower the pinned baseline:\n  ${improved.join('\n  ')}`,
      )
    }
    expect(over, `WebGPU type usage INCREASED in backend-neutral engine code:\n${over.join('\n')}`).toEqual([])
  })
})
