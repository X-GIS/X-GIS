// ═══ Seeding the emit pool from the bake — served, not emitted (#1678) ═══
//
// The claim this file has to settle is not "the pool ends up holding the right bytes"
// (a runtime emit produces those too, byte-for-byte — `baked-sync.test.ts` is what pins
// that). It is that the bake ANSWERS INSTEAD OF the emitter: `peekShaderSources` must
// return a hillshade source on the first ask, with the optimizer fixpoint never run.
//
// §12 — an assertion that would pass whether or not the mechanism ran is worthless, so
// the emitter is COUNTED. `vi.mock` wraps the real `emitFor` (the ONE dispatch the
// worker and the main-thread fallback share) in a counter, and every case below states
// what that counter must read. The CONTROL case drives the same request with no seed
// and requires the counter to MOVE — without it, `emitCalls === 0` could just as well
// mean the counter is dead.
//
// Node has no `Worker`, so `requestShaderSources` takes the documented main-thread
// fallback. That is the path being distinguished from: a seeded key must not reach it.
//
// CUT PROBE (verified while landing this): sever the seeding — make `seedShaderSources`
// a no-op, or drop the `seedShaderSources(...)` call from the loop in
// `seed-hillshade.ts` — and the first four cases go red on the peek, naming the seed.
// The CONTROL case stays green, which is what tells the two apart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EARTH, MOON, configureBody, type Body } from '@xgis/shared'
import { PROJECTIONS } from '@xgis/geo'
import { configureProjections } from '../dsl/projections'
import { configureBodyConsts } from '../../body-consts'
import {
  peekShaderSources,
  requestShaderSources,
  _resetShaderEmitCache,
} from '../emit/shader-emit-pool'
import type { ShaderEmitRequest } from '../emit/shader-emit-request'
import type { ShaderSourceDevice } from '../../render/material/wgsl-for'
import {
  seedBakedShaders,
  seedHillshadeFromArtifact,
  _resetBakedSeedWarning,
} from './seed-hillshade'
import { _resetBakedBodyGuardMemo } from './body-guard'
import { HILLSHADE_METHOD_FLAGS, hillshadeGlslId, hillshadeWgslId } from './ids'
import { BAKED_GLSL_HILLSHADE } from './baked-glsl-hillshade.generated'
import { BAKED_WGSL_HILLSHADE } from './baked-wgsl-hillshade.generated'
import type { BakedArtifact } from './registry'

// The emit counter. `vi.hoisted` because the mock factory is hoisted above the imports;
// the wrapper delegates to the REAL emitFor, so nothing about the fallback's behaviour
// changes — only that it becomes observable.
const probe = vi.hoisted(() => ({ emitCalls: 0 }))
vi.mock('../emit/shader-emit-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../emit/shader-emit-request')>()
  return {
    ...actual,
    emitFor: (...args: Parameters<typeof actual.emitFor>) => {
      probe.emitCalls++
      return actual.emitFor(...args)
    },
  }
})

configureProjections(PROJECTIONS)

const switchBody = (body: Body): void => {
  configureBody(body)
  configureBodyConsts(body)
}

// methodFlag 4 = multidirectional — the heaviest emit and the one the demo authors.
const REQ: ShaderEmitRequest = { family: 'hillshade', pick: false, methodFlag: 4 }

const sourceOf = (artifact: BakedArtifact, id: string): string => {
  const hash = artifact.index[id]
  expect(hash, `${id}: absent from the baked index`).toBeTypeOf('string')
  return artifact.contents[hash as string] as string
}

beforeEach(() => {
  _resetShaderEmitCache()
  _resetBakedBodyGuardMemo()
  _resetBakedSeedWarning()
  probe.emitCalls = 0
})

afterEach(() => {
  switchBody(EARTH)
  _resetBakedBodyGuardMemo()
})

describe('baked shaders — seeding the emit pool (#1678)', () => {
  it('seeds every hillshade permutation the closed set covers', () => {
    const expected = HILLSHADE_METHOD_FLAGS.length * 2
    expect(seedHillshadeFromArtifact(BAKED_GLSL_HILLSHADE, false)).toBe(expected)
    // Counted through the POOL, not through the return value: the return value is what
    // the seeder BELIEVES it did, and a gate that reads it back is asserting on the
    // wrong side of the seam.
    const answered = HILLSHADE_METHOD_FLAGS.flatMap((methodFlag) =>
      [false, true].map((pick) => peekShaderSources({ family: 'hillshade', pick, methodFlag })),
    ).filter((s) => s !== undefined).length
    expect(answered, 'every seeded key must be answerable by the pool').toBe(expected)
    expect(probe.emitCalls, 'seeding must not emit anything').toBe(0)
  })

  it('a seeded pool answers peek with the BAKED bytes, and the emitter never runs', () => {
    expect(peekShaderSources(REQ), 'cold pool: nothing to serve').toBeUndefined()
    seedHillshadeFromArtifact(BAKED_GLSL_HILLSHADE, false)
    const seeded = peekShaderSources(REQ)
    expect(seeded, 'the draper‘s first-frame peek must hit').toBeDefined()
    expect(seeded?.vertex).toBe(sourceOf(BAKED_GLSL_HILLSHADE, hillshadeGlslId(4, false, 'vertex')))
    expect(seeded?.fragment).toBe(
      sourceOf(BAKED_GLSL_HILLSHADE, hillshadeGlslId(4, false, 'fragment')),
    )
    // The mirror of `emitFor`'s own rule — a GLSL device never pays for the WGSL.
    expect(seeded?.wgsl).toBe('')
    expect(probe.emitCalls, 'served from the bake: emitFor must not have run').toBe(0)
  })

  it('a seeded key short-circuits requestShaderSources — same object, no emit', async () => {
    seedHillshadeFromArtifact(BAKED_GLSL_HILLSHADE, false)
    const got = await requestShaderSources(REQ, false)
    // Identity, not equality — but note what it does and does NOT prove: the pool caches
    // whatever it produced under the same key, so `got === peek` holds whether the seed
    // answered or an emit ran and was cached. It pins that ONE object is served (no
    // second cache in front of `done`, no copy). The counter on the next line is the only
    // carrier of "the emitter never ran" — do not delete it and lean on the identity.
    expect(got).toBe(peekShaderSources(REQ))
    expect(probe.emitCalls).toBe(0)
  })

  it('CONTROL — the same request with no seed really does pay an emit', async () => {
    const got = await requestShaderSources(REQ, false)
    expect(
      probe.emitCalls,
      'the counter is live: an unseeded request runs emitFor',
    ).toBeGreaterThan(0)
    // …and produces exactly the bytes the bake would have served, which is why swapping
    // one for the other is invisible to the frame.
    expect(got.vertex).toBe(sourceOf(BAKED_GLSL_HILLSHADE, hillshadeGlslId(4, false, 'vertex')))
    expect(got.fragment).toBe(sourceOf(BAKED_GLSL_HILLSHADE, hillshadeGlslId(4, false, 'fragment')))
  })

  it('a WGSL device is seeded with the WGSL module, and no GLSL', () => {
    expect(seedHillshadeFromArtifact(BAKED_WGSL_HILLSHADE, true)).toBe(
      HILLSHADE_METHOD_FLAGS.length * 2,
    )
    const seeded = peekShaderSources(REQ)
    expect(seeded?.wgsl).toBe(sourceOf(BAKED_WGSL_HILLSHADE, hillshadeWgslId(4, false)))
    // rhi-webgpu's createPipeline reads `desc.code` and ignores vsCode/fsCode entirely,
    // so shipping the GLSL half to a WebGPU device would be a download nothing reads.
    expect(seeded?.vertex).toBe('')
    expect(seeded?.fragment).toBe('')
    expect(probe.emitCalls).toBe(0)
  })

  it('the pick permutations are seeded apart — one pass must not serve the other‘s bytes', () => {
    seedHillshadeFromArtifact(BAKED_GLSL_HILLSHADE, false)
    const nopick = peekShaderSources({ family: 'hillshade', pick: false, methodFlag: 4 })
    const pick = peekShaderSources({ family: 'hillshade', pick: true, methodFlag: 4 })
    expect(nopick?.fragment).toBeDefined()
    expect(pick?.fragment).toBeDefined()
    expect(pick?.fragment).not.toBe(nopick?.fragment)
    expect(probe.emitCalls).toBe(0)
  })

  it('MOON: the body guard stops the seed reaching the pool at all', () => {
    switchBody(MOON)
    expect(seedHillshadeFromArtifact(BAKED_GLSL_HILLSHADE, false)).toBe(0)
    expect(
      peekShaderSources(REQ),
      'nothing may be seeded on a body the artifact was not baked under',
    ).toBeUndefined()
  })

  it('every id the seeder spells resolves in BOTH artifacts (#996: a dead lookup is silent)', () => {
    // The seeder cannot import the registry (it would drag every dsl emitter into the
    // runtime bundle), so `ids.ts` is the shared spelling. This proves the strings it
    // produces still ADDRESS something — a rename that left the seeder pointing at
    // nothing would otherwise degrade silently to "the bake never helps".
    for (const methodFlag of HILLSHADE_METHOD_FLAGS)
      for (const pick of [false, true]) {
        expect(BAKED_WGSL_HILLSHADE.index[hillshadeWgslId(methodFlag, pick)]).toBeTypeOf('string')
        for (const stage of ['vertex', 'fragment'] as const)
          expect(BAKED_GLSL_HILLSHADE.index[hillshadeGlslId(methodFlag, pick, stage)]).toBeTypeOf(
            'string',
          )
      }
  })
})

// ═══ The BOOT entry — `seedBakedShaders`, the line gpu-boot.ts actually calls ═══
//
// Everything above drives `seedHillshadeFromArtifact`, which is pure and takes the
// artifact as an argument. That left the WHOLE boot half unasserted: which of the four
// committed files gets imported, the `?nobake` opt-out, and the never-throw contract.
// Measured while landing this: deleting `await seedBakedShaders(ctx.rhi)` from
// gpu-boot.ts kept all 133 tests in this directory green — the seam had no coverage at
// all. The arms below are that coverage, driven through the real dynamic import.
//
// WHAT THEY DO NOT COVER, deliberately: the gpu-boot CALL SITE. They invoke
// `seedBakedShaders` themselves, so deleting that one line from `bootGpuContext` still
// passes here. What catches it is the render gate
// (`playground/e2e/_1678-hillshade-bake-hash-gate.spec.ts`), whose arm A requires a
// converged hillshade frame with `__xgisBakedShaderSeeds > 0` and `__xgisShaderEmits === 0`
// — a claim about the FRAME, which no unit test can make.
//
// The device is the narrow `ShaderSourceDevice` (wgsl-for.ts) — `{ caps: {
// shaderLanguage } }` and nothing else — which is the whole point of that interface
// being narrow: the boot path reads the capability, never a backend identity.
describe('baked shaders — seedBakedShaders, the boot entry (#1678)', () => {
  const GLSL_DEVICE: ShaderSourceDevice = { caps: { shaderLanguage: 'glsl-es300' } }
  const WGSL_DEVICE: ShaderSourceDevice = { caps: { shaderLanguage: 'wgsl' } }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a GLSL device imports the GLSL hillshade artifact and fills the pool', async () => {
    const n = await seedBakedShaders(GLSL_DEVICE)
    expect(n, 'the boot entry must seed every hillshade permutation').toBe(
      HILLSHADE_METHOD_FLAGS.length * 2,
    )
    const seeded = peekShaderSources(REQ)
    expect(seeded?.vertex).toBe(sourceOf(BAKED_GLSL_HILLSHADE, hillshadeGlslId(4, false, 'vertex')))
    expect(seeded?.fragment).toBe(
      sourceOf(BAKED_GLSL_HILLSHADE, hillshadeGlslId(4, false, 'fragment')),
    )
    expect(probe.emitCalls, 'the boot path must not emit anything').toBe(0)
  })

  it('a WGSL device imports the WGSL artifact — the WGSL field only, no GLSL', async () => {
    expect(await seedBakedShaders(WGSL_DEVICE)).toBe(HILLSHADE_METHOD_FLAGS.length * 2)
    const seeded = peekShaderSources(REQ)
    expect(seeded?.wgsl).toBe(sourceOf(BAKED_WGSL_HILLSHADE, hillshadeWgslId(4, false)))
    // The language asymmetry is the reason the artifact is split by language at all: a
    // WebGPU device that also downloaded the GLSL would be paying for bytes no pipeline
    // on it can read.
    expect(seeded?.vertex).toBe('')
    expect(seeded?.fragment).toBe('')
    expect(probe.emitCalls).toBe(0)
  })

  it('?nobake=1 turns the whole seam off — 0 seeded, nothing in the pool', async () => {
    // Driven exactly as production reads it: `bakedShadersDisabled()` (debug-flags.ts)
    // parses `window.location.href` live, per boot. The node test env has no window, so
    // the stub IS the URL.
    vi.stubGlobal('window', { location: { href: 'http://localhost/demo.html?nobake=1' } })
    expect(await seedBakedShaders(GLSL_DEVICE)).toBe(0)
    expect(
      peekShaderSources(REQ),
      'the control arm of the render gate must leave the pool untouched',
    ).toBeUndefined()
    // The seed count is still published — the gate reads 0 to prove the arm differed.
    expect((window as unknown as { __xgisBakedShaderSeeds?: number }).__xgisBakedShaderSeeds).toBe(
      0,
    )
  })

  // An artifact chunk that will not load — a 404 on a deploy rollover, a CSP refusal, a
  // renamed export after a bad merge — must cost a slower first hillshade frame, never a
  // dead map: `bootGpuContext` AWAITS this call, so a rejection here takes the whole boot
  // down. Faked at the module boundary with `vi.doMock` (not hoisted) plus a fresh import
  // of the module under test, so the REAL artifact path the three arms above drive stays
  // untouched. Both failure shapes are covered — the import rejecting, and the import
  // succeeding with the export absent.
  const BROKEN_ARTIFACT: ReadonlyArray<{ how: string; factory: () => Promise<object> | object }> = [
    { how: 'the chunk fails to load', factory: () => Promise.reject(new Error('simulated 404')) },
    { how: 'the chunk loads without the export', factory: () => ({}) },
  ]
  for (const { how, factory } of BROKEN_ARTIFACT)
    it(`returns 0 instead of rejecting the boot when ${how}`, async () => {
      vi.resetModules()
      vi.doMock('./baked-glsl-hillshade.generated', factory)
      try {
        const fresh = await import('./seed-hillshade')
        await expect(fresh.seedBakedShaders(GLSL_DEVICE)).resolves.toBe(0)
      } finally {
        vi.doUnmock('./baked-glsl-hillshade.generated')
        vi.resetModules()
      }
    })
})
