// The advected-arrow draw's bind layout, asserted against the EMITTED shader (#1419).
//
// WebGL2 binds group entries BY NAME (rhi.ts #783), so an entry whose `name` does not match the
// shader's resource identifier binds nothing — and it fails on WebGL2 only, which is the backend
// the headless render gate drives. And on WebGPU a texture entry without `vertexVisible` is
// FRAGMENT-only, so the VS's `textureLoad` fails validation at DRAW time: the pipeline builds,
// the layer simply never renders. Neither failure is visible in a diff, so both are pinned here.

import { describe, it, expect } from 'vitest'
import { ARROW_ADVECTED_BINDINGS } from './arrow-retained-advected-material'
import {
  ARROW_ADVECT_BINDINGS,
  ARROW_ADVECT_UNIFORM_FLOATS,
  packArrowAdvectUniform,
} from './arrow-advect-material'
import { emitArrowRetainedAdvectedWgsl } from '../../shaders/dsl/arrow-retained'
import { emitArrowAdvectWgsl, emitArrowAdvectGlsl } from '../../shaders/dsl/arrow-advect-step'

describe('advected arrow DRAW — group 1 matches the shader', () => {
  const w = emitArrowRetainedAdvectedWgsl()

  it('every entry names a resource the shader actually declares, at that binding', () => {
    for (const e of ARROW_ADVECTED_BINDINGS) {
      expect(w, `${e.name} at @binding(${e.binding})`).toMatch(
        new RegExp(`@group\\(1\\) @binding\\(${e.binding}\\) var[^\\n]*\\b${e.name}\\b`),
      )
    }
  })

  it('every group-1 resource the shader declares has an entry — none left unbound', () => {
    const declared = [...w.matchAll(/@group\(1\) @binding\((\d+)\) var[^\n]*?(\w+):/g)].map(
      (m) => ({
        binding: Number(m[1]),
        name: m[2],
      }),
    )
    expect(declared.length).toBe(ARROW_ADVECTED_BINDINGS.length)
    for (const d of declared) {
      const entry = ARROW_ADVECTED_BINDINGS.find((e) => e.binding === d.binding)
      expect(entry, `binding ${d.binding} (${d.name}) has no layout entry`).toBeDefined()
      expect(entry!.name).toBe(d.name)
    }
  })

  it('EVERY texture is vertexVisible — the VS is what reads them', () => {
    for (const e of ARROW_ADVECTED_BINDINGS) {
      if (e.kind === 'texture') {
        expect(
          'vertexVisible' in e && e.vertexVisible,
          `${e.name} is read by textureLoad in the vertex stage`,
        ).toBe(true)
      }
    }
  })
})

describe('advected arrow STEP — group 0 matches the shader', () => {
  const w = emitArrowAdvectWgsl()

  it('every entry names a resource the shader declares, at that binding', () => {
    for (const e of ARROW_ADVECT_BINDINGS) {
      expect(w, `${e.name} at @binding(${e.binding})`).toMatch(
        new RegExp(`@group\\(0\\) @binding\\(${e.binding}\\) var[^\\n]*\\b${e.name}\\b`),
      )
    }
  })

  it('the origin texture is bound — without it every arrow leashes to grid-uv (0,0)', () => {
    expect(ARROW_ADVECT_BINDINGS.some((e) => e.name === 'origin_tex')).toBe(true)
  })

  it('the params struct carries the MOSAIC RANGE, and the fs discards outside it (#1458)', () => {
    // One state texture, one pass PER REGION (each domain has its own velocity pair), so a pass
    // that wrote the whole texture would have the last region overwrite every sibling's
    // position — #1459's texel collision reintroduced one layer up. Both halves are asserted:
    // the field must exist AND be read, since an unread uniform is a mask that does nothing.
    expect(w).toMatch(/struct ArrowAdvectParams\b[\s\S]*?\brange\s*:\s*vec4<f32>/)
    expect(w).toMatch(/discard/)
    expect(w).toMatch(/\brange\.x\b/)
    expect(w).toMatch(/\brange\.y\b/)
  })

  it('the GLSL twin carries the same mask — a backend that skipped it would collide', () => {
    const g = emitArrowAdvectGlsl('fragment')
    expect(g).toMatch(/discard/)
    expect(g).toMatch(/range/)
  })

  it('the packer writes the range where the struct declares it', () => {
    // step(4) + seed(4) + range(4). A packer that wrote the base at the wrong offset would mask
    // by the seed, and every region would step a different arbitrary slice each frame.
    const u = packArrowAdvectUniform(1, 2, 3, 4, 0.5, 17, 42)
    expect(u).toHaveLength(ARROW_ADVECT_UNIFORM_FLOATS)
    expect([u[8], u[9]]).toEqual([17, 42])
  })
})
