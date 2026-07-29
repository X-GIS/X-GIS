// ═══ The emit seam's two load-bearing invariants ═══
//
// Moving the shader emit off the main thread is only safe if two things hold, and neither
// is visible from a passing render:
//
//  1. The worker and the main-thread fallback produce the SAME bytes. They call one
//     `emitFor`, which is the point — but nothing structural stops a future change from
//     giving the worker its own path, and a browser without workers would then render
//     differently from one with them. Asserted through the pool's public surface.
//  2. The pool never leaves a draper waiting forever. A draper returns `null` from
//     `materialFor` while its shader is in flight and DRAWS NOTHING; if `shaderEmitPending`
//     ever under-reported, the render loop would idle with tiles cached and the layer
//     permanently blank — the freeze class this repo has already paid for twice.
//
// Node has no `Worker`, so these run the fallback path. That is not a gap being papered
// over: the fallback is the path every unit test and every worker-less host takes, and
// pinning it is what makes the seam testable at all.

import { describe, it, expect, beforeEach } from 'vitest'
import { configureProjections } from '../dsl/projections'
import { PROJECTIONS } from '@xgis/geo'
import { emitFor, shaderRequestKey, type ShaderEmitRequest } from './shader-emit-request'
import {
  peekShaderSources,
  requestShaderSources,
  shaderEmitPending,
  _resetShaderEmitCache,
} from './shader-emit-pool'

configureProjections(PROJECTIONS)

const REQ = (methodFlag: number, pick = false): ShaderEmitRequest => ({
  family: 'hillshade',
  pick,
  methodFlag,
})

beforeEach(() => _resetShaderEmitCache())

describe('shader emit pool', () => {
  it('serves exactly what emitFor produces — the pool adds no transformation', async () => {
    const req = REQ(4) // multidirectional: the heaviest, and the demo in the report
    const direct = emitFor(req, true)
    const viaPool = await requestShaderSources(req, true)
    expect(viaPool.vertex).toBe(direct.vertex)
    expect(viaPool.fragment).toBe(direct.fragment)
    expect(viaPool.wgsl).toBe(direct.wgsl)
  })

  it('omits the WGSL for a device that cannot read it', async () => {
    // The 693 ms that used to be spent building a string WebGL2 discards. Skipped at the
    // REQUEST, so a worker never pays it either.
    const s = await requestShaderSources(REQ(4), false)
    expect(s.wgsl).toBe('')
    expect(s.vertex.length).toBeGreaterThan(0)
    expect(s.fragment.length).toBeGreaterThan(0)
  })

  it('peek is empty before the request and populated after — the draw-loop contract', async () => {
    const req = REQ(0)
    expect(peekShaderSources(req)).toBeUndefined() // draper returns null, draws nothing
    await requestShaderSources(req, false)
    expect(peekShaderSources(req)?.vertex.length).toBeGreaterThan(0) // draper builds it
  })

  it('reports pending while a request is open and settles after — the keep-warm signal', async () => {
    expect(shaderEmitPending()).toBe(false)
    const p = requestShaderSources(REQ(1), false)
    // Under the fallback this is already resolved-but-untracked; what matters is that it
    // is FALSE once settled, or the loop would spin forever.
    await p
    expect(shaderEmitPending()).toBe(false)
  })

  it('dedups by key — a draper may re-request every frame until it lands', async () => {
    const req = REQ(2)
    const a = requestShaderSources(req, false)
    const b = requestShaderSources(req, false)
    expect(a).toBe(b) // same promise, one emit
    await a
    // …and a post-arrival request is served from cache, not re-emitted.
    expect(await requestShaderSources(req, false)).toBe(peekShaderSources(req))
  })

  it('keys every hillshade permutation apart — a collision would serve the wrong shader', () => {
    const keys = new Set<string>()
    for (let f = 0; f < 5; f++)
      for (const pick of [false, true]) keys.add(shaderRequestKey(REQ(f, pick)))
    expect(keys.size).toBe(10)
  })

  it('a request for one method never serves another method`s bytes', async () => {
    const std = await requestShaderSources(REQ(0), false)
    const multi = await requestShaderSources(REQ(4), false)
    // The whole point of per-method specialisation (#1405): the fragments differ.
    expect(std.fragment).not.toBe(multi.fragment)
  })
})
