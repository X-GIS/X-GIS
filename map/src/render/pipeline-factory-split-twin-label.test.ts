// ═══ The per-style SPLIT twin labels its pipelines with its style key (#2627) ═══
//
// #2499's boot-provenance gate classifies a compiled program as OPEN SET — style-derived
// bytes the closed set is defined to exclude — from a `shader-` PIPELINE LABEL prefix
// (`_2499-boot-shader-provenance-gate.spec.ts`: `OPEN_SET_LABEL = /^shader-./`). Labels are
// the only channel it has: it wraps `createShaderModule` at the driver, where all it sees is
// bytes and a label.
//
// `perStyleSplitTwin` builds its Materials through the SHARED `buildFlatFillMaterials`, whose
// four labels are generic by design (`fill-flat-write-rhi`, …) because one builder serves many
// callers. Its legacy sibling `registerFillMaterials` is classified correctly only by accident:
// it reuses bytes the variant PIPELINE path already compiled under `shader-${variant.key}`
// (pipeline-factory.ts ~1369), and the gate's `isOpen` is a `some(...)` over a program's whole
// label set. The split twin has no such second compile, so its program — a per-style composer
// variant carrying the compiler's FILL_COLOR / STROKE_COLOR / OPACITY consts — read as a
// CLOSED-set family emitting at runtime and red the gate.
//
// WHY THIS TEST EXISTS RATHER THAN THE RENDER GATE ALONE. The twin was dead code from INC-4d
// until #2620 routed a draw to it (measured there: 0 → 184 per-style split draws), so the gate
// could not see the gap, and after #2620 the gate's verdict depends on that fix being present.
// A fix whose only witness is another change is the witness-nothing-can-reach trap (#2165).
// This pins the label at the producer, with no GPU and no dependency on the draw path.

import { describe, it, expect, vi } from 'vitest'

// The twin's eligibility probe and its emit are the expensive, IR-shaped half and are NOT what
// this test is about — stubbed so the assertion is about the LABEL and nothing else. The real
// pair has its own coverage in `map/src/shaders/dsl/split-bind-eligibility.test.ts`.
vi.mock('./polygon-shader-cache', () => ({
  buildShader: () => 'unused-by-this-test',
  buildSplitShader: () => 'fn vs_main_ecef() {} fn fs_fill() {}',
  splitShaderFits: () => true,
}))

import { PipelineFactory } from './pipeline-factory'
import type { ShaderVariantInfo } from './renderer-types'

const VARIANT_KEY = 'f:#e7e5e4|s:#a8a29e|o:1'

interface Captured {
  label?: string
}

/** The factory state `perStyleSplitTwin` reads, and nothing else — `Object.create` skips class
 *  field initializers, so every field the path touches is injected by hand (the same shape
 *  `pipeline-factory-compute-layout-authority.test.ts` uses). */
function makeFactory(): { f: PipelineFactory; pipelines: Captured[]; key: object } {
  const pipelines: Captured[] = []
  const rhi = {
    backend: 'webgpu' as const,
    createPipeline: vi.fn((d: Captured) => {
      pipelines.push(d)
      return { __label: d.label }
    }),
    createBindGroupLayout: vi.fn((x: unknown) => x),
    createBuffer: vi.fn(() => ({})),
  }
  const f = Object.create(PipelineFactory.prototype) as PipelineFactory
  const anyF = f as unknown as Record<string, unknown>
  anyF.ctx = { device: {}, format: 'bgra8unorm', rhi }
  anyF._fillSplitLayout = { label: 'split-layout-sentinel' }
  anyF._fillPerStyleSplit = new Map()
  const key = { __pipeline: 'fill' }
  const pipelineSet = {
    fillPipeline: key,
    fillPipelineFallback: { __pipeline: 'fill-fallback' },
    fillPipelineGround: { __pipeline: 'ground' },
    fillPipelineGroundFallback: { __pipeline: 'ground-fallback' },
  }
  anyF._fillPerStyleInfo = new Map([
    [
      key,
      { variant: { key: VARIANT_KEY } as unknown as ShaderVariantInfo, pipelines: pipelineSet },
    ],
  ])
  return { f, pipelines, key }
}

describe('#2627 — the per-style split twin is identifiable as OPEN SET by its label', () => {
  it('every pipeline it creates is labelled `shader-<variant.key>/…`', () => {
    const { f, pipelines, key } = makeFactory()

    const twin = f.perStyleSplitTwin(key as never)
    expect(twin, 'the twin must build — otherwise this test asserts about nothing').not.toBeNull()

    expect(pipelines.length, 'flat + ground Materials, two variants each').toBeGreaterThan(0)
    for (const p of pipelines)
      expect(
        p.label,
        `#2499 classifies an open-set program by a leading \`shader-\`; a generic ` +
          `\`fill-*-rhi\` label here makes this per-style program read as a CLOSED-set family ` +
          `emitting at runtime and reds _2499-boot-shader-provenance-gate`,
      ).toMatch(/^shader-./)

    // The key itself must survive into the label — a constant prefix would satisfy the regex
    // above while telling the gate (and a GPU debugger) nothing about WHICH style this is.
    for (const p of pipelines) expect(p.label).toContain(VARIANT_KEY)

    // …and the generic name is still there, so the label remains readable as what it is.
    expect(pipelines.map((p) => p.label).join('|')).toContain('fill-flat-write-rhi')
  })
})
