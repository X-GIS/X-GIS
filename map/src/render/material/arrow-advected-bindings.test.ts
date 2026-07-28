// The advected-arrow draw's bind layout, asserted against the EMITTED shader (#1419).
//
// WebGL2 binds group entries BY NAME (rhi.ts #783), so an entry whose `name` does not match the
// shader's resource identifier binds nothing — and it fails on WebGL2 only, which is the backend
// the headless render gate drives. And on WebGPU a texture entry without `vertexVisible` is
// FRAGMENT-only, so the VS's `textureLoad` fails validation at DRAW time: the pipeline builds,
// the layer simply never renders. Neither failure is visible in a diff, so both are pinned here.

import { describe, it, expect } from 'vitest'
import { ARROW_ADVECTED_BINDINGS } from './arrow-retained-advected-material'
import { ARROW_ADVECT_BINDINGS } from './arrow-advect-material'
import { emitArrowRetainedAdvectedWgsl } from '../../shaders/dsl/arrow-retained'
import { emitArrowAdvectWgsl } from '../../shaders/dsl/arrow-advect-step'

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
})
