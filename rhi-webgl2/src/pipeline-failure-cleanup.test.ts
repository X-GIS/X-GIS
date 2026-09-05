// ═══ #2369 F-7 — a failed compile or link must not strand GL objects ═══
//
// WebGLShader / WebGLProgram are not GC-reclaimed: this file's own success path
// deletes its shaders for exactly that reason, and its comment elsewhere states
// a program "is not GC-collected, so without this delete repeated pipeline
// creation … accumulates GL programs unboundedly". Three exits skipped that
// discipline, all on a LIVE context:
//
//   1. compile() threw on COMPILE_STATUS without deleting the shader it made;
//   2. createPipeline compiles vertex THEN fragment — a fragment failure (or a
//      null createProgram) abandoned the vertex shader;
//   3. a LINK_STATUS failure threw above the deleteShader pair, stranding the
//      program AND both shaders.
//
// Variant pipelines compile lazily at runtime, so a shader that fails to build
// does so once per attempt for as long as the page lives.
//
// The observable is the create/delete PAIRING against a recording fake context
// (the createpipeline-mrt-divergence-guard.test.ts shape) — no GL required,
// because what is under test is bookkeeping, not any GL effect.

import { describe, expect, it } from 'vitest'
import type { RhiPipelineDesc } from '@xgis/rhi'
import { WebGl2Device } from './rhi-webgl2'

const VERTEX_SHADER = 0x8b31
const FRAGMENT_SHADER = 0x8b30
const COMPILE_STATUS = 0x8b81
const LINK_STATUS = 0x8b82

interface Fake {
  gl: WebGL2RenderingContext
  /** Every object handed out, in creation order. */
  created: string[]
  /** Every object explicitly released. */
  deleted: string[]
}

/** A context whose shader/program outcomes are scripted per stage. */
function fakeGl(opts: {
  vsCompiles?: boolean
  fsCompiles?: boolean
  links?: boolean
  program?: boolean
}): Fake {
  const { vsCompiles = true, fsCompiles = true, links = true, program = true } = opts
  const created: string[] = []
  const deleted: string[] = []
  const gl = {
    VERTEX_SHADER,
    FRAGMENT_SHADER,
    COMPILE_STATUS,
    LINK_STATUS,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    createSampler: () => ({}),
    samplerParameteri: () => {},
    createShader: (type: number) => {
      const name = type === VERTEX_SHADER ? 'vs' : 'fs'
      created.push(name)
      return { __name: name }
    },
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: (sh: { __name: string }) => (sh.__name === 'vs' ? vsCompiles : fsCompiles),
    getShaderInfoLog: () => 'scripted failure',
    // Real WebGL accepts null here (it is a documented no-op); the fake must
    // model that rather than throwing, or it would fail the production code for
    // a difference that does not exist on a real context.
    deleteShader: (sh: { __name: string } | null) => void (sh && deleted.push(sh.__name)),
    createProgram: () => {
      if (!program) return null
      created.push('program')
      return { __name: 'program' }
    },
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => links,
    getProgramInfoLog: () => 'scripted link failure',
    deleteProgram: (p: { __name: string }) => void deleted.push(p.__name),
    useProgram: () => {},
    // Reflection runs only past a successful link; keep it inert.
    getProgramParameter_: () => 0,
    getActiveUniform: () => null,
    getActiveUniformBlockName: () => null,
    getUniformLocation: () => null,
  }
  return { gl: gl as unknown as WebGL2RenderingContext, created, deleted }
}

const desc: RhiPipelineDesc = {
  code: 'wgsl-source',
  vsCode: '#version 300 es\nvoid main(){}',
  fsCode: '#version 300 es\nvoid main(){}',
  vsEntry: 'vs_main',
  fsEntry: 'fs_main',
  bindGroupLayouts: [],
  colorTargets: [{ format: 'bgra8unorm' }],
}

/** Everything created must have been released — the invariant all three cases share. */
function expectNothingStranded(f: Fake): void {
  expect([...f.deleted].sort(), `created ${f.created.join(',')}`).toEqual([...f.created].sort())
}

describe('#2369 F-7 — createPipeline releases what it created on every failing exit', () => {
  it('vertex compile failure strands nothing', () => {
    const f = fakeGl({ vsCompiles: false })
    expect(() => new WebGl2Device(f.gl).createPipeline(desc)).toThrow(/compile failed/)
    expect(f.created, 'the vertex shader was created before the failure').toContain('vs')
    expectNothingStranded(f)
  })

  it('fragment compile failure does not abandon the vertex shader', () => {
    const f = fakeGl({ fsCompiles: false })
    expect(() => new WebGl2Device(f.gl).createPipeline(desc)).toThrow(/compile failed/)
    expect(f.created, 'both stages were created before the failure').toEqual(['vs', 'fs'])
    expectNothingStranded(f)
  })

  it('link failure strands neither the program nor the shaders', () => {
    const f = fakeGl({ links: false })
    expect(() => new WebGl2Device(f.gl).createPipeline(desc)).toThrow(/link failed/)
    expect(f.created, 'the program and both shaders existed at the throw').toEqual([
      'vs',
      'fs',
      'program',
    ])
    expectNothingStranded(f)
  })

  it('a null createProgram does not abandon the compiled shaders', () => {
    const f = fakeGl({ program: false })
    expect(() => new WebGl2Device(f.gl).createPipeline(desc)).toThrow(/createProgram failed/)
    expect(f.created).toEqual(['vs', 'fs'])
    expectNothingStranded(f)
  })

  it('CONTROL — the SUCCESS path still deletes both shaders exactly once', () => {
    // Without this the cleanup could satisfy every case above by deleting
    // nothing and creating nothing, or by leaving the success path leaking.
    const f = fakeGl({})
    try {
      new WebGl2Device(f.gl).createPipeline(desc)
    } catch {
      // Reflection past the link needs more of the GL surface than this fake
      // carries; the shader bookkeeping under test has already happened.
    }
    expect(f.deleted.filter((n) => n === 'vs')).toHaveLength(1)
    expect(f.deleted.filter((n) => n === 'fs')).toHaveLength(1)
  })
})
