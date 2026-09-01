// ═══ #1578 — a Material must release what its constructor created ═══
//
// `map.setQuality({msaa})` / `{picking}` discards six RHI-seam drapers by nulling their
// references and rebuilds them at the new sample count. Each dropped draper owned a
// `Material` holding pipelines, a global uniform buffer and per-slot pool buffers — and
// `Material` had no `destroy()`, while `RhiDevice.destroyPipeline` had **zero production
// callers anywhere in the repo**. Its siblings `destroyBuffer` / `destroySampler` are
// called from text, icon and heatmap, so this was an omission rather than a policy.
//
// On WebGL2 that leaked linked GL programs on a LIVE context — `rhi-webgl2.ts`'s own
// comment states a program is not GC-collected, "so without this delete repeated pipeline
// creation … accumulates GL programs unboundedly". On WebGPU the pipelines are GC-owned by
// spec, but the uniform and pool `GPUBuffer`s free only if their JS wrappers happen to be
// collected — the failure mode this codebase already calls "the iOS staircase".
//
// End-of-life was never the uncovered path: `rhi.destroy()` reclaims everything at
// teardown. What no teardown gate can see is live-operation churn, which is what this is.
//
// Harness mirrors map/src/render/material/extrude-front-shell.test.ts — a recording fake
// RhiDevice, because what is under test is the create/destroy PAIRING, not any GPU effect.

import { describe, it, expect } from 'vitest'
import { Material } from './material'
import type { RhiDevice, RhiBuffer, RhiPipeline } from '@xgis/rhi'

/** Records every create/destroy so the pairing can be asserted directly. */
function recordingRhi() {
  const log: string[] = []
  let n = 0
  const rhi = {
    createBindGroupLayout: () => ({ id: `layout${n++}` }),
    createPipeline: () => {
      const p = { id: `pipeline${n++}` }
      log.push(`create:${p.id}`)
      return p
    },
    createBuffer: () => {
      const b = { id: `buffer${n++}` }
      log.push(`create:${b.id}`)
      return b
    },
    createBindGroup: () => ({ id: `bg${n++}` }),
    writeBuffer: () => {},
    destroyPipeline: (p: RhiPipeline) => log.push(`destroy:${(p as unknown as { id: string }).id}`),
    destroyBuffer: (b: RhiBuffer) => log.push(`destroy:${(b as unknown as { id: string }).id}`),
  } as unknown as RhiDevice
  const created = (): string[] => log.filter((l) => l.startsWith('create:')).map((l) => l.slice(7))
  const destroyed = (): string[] =>
    log.filter((l) => l.startsWith('destroy:')).map((l) => l.slice(8))
  return { rhi, created, destroyed }
}

/** A material with the shape the RHI-seam drapers build: several pipeline variants, a
 *  global uniform, and a per-item pool. */
function makeMaterial(rhi: RhiDevice): Material {
  return new Material(rhi, {
    shader: 'STUB',
    vsEntry: 'vs',
    fsEntry: 'fs',
    groups: [[{ binding: 0, kind: 'uniform' }], [{ binding: 0, kind: 'uniform' }]],
    variants: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    colorTargets: [{ format: 'bgra8unorm' }],
    sampleCount: 4,
    globalUniformSize: 256,
    pool: { group: 1, slotSize: 64 },
  } as never)
}

describe('#1578 — Material.destroy releases every handle its constructor created', () => {
  it('destroys every pipeline, the global uniform, and every pool slot', () => {
    const { rhi, created, destroyed } = recordingRhi()
    const mat = makeMaterial(rhi)
    // Grow the pool the way `executeItems` does, so slots exist to leak.
    mat.poolSlot(0)
    mat.poolSlot(1)
    mat.poolSlot(2)

    expect(created().length, 'ctor + pool: 3 pipelines + 1 global + 3 slots').toBe(7)
    expect(destroyed(), 'nothing released yet').toEqual([])

    mat.destroy()

    // THE gate: every created handle is released, and nothing else is. Before the fix
    // `destroy()` did not exist and this set was empty forever.
    expect(destroyed().sort()).toEqual(created().sort())
  })

  it('is idempotent — a second destroy double-frees nothing', () => {
    // A draper can be destroyed twice (a quality flip landing during teardown), and a
    // double `gl.deleteProgram` on a recycled handle is worse than a leak.
    const { rhi, created, destroyed } = recordingRhi()
    const mat = makeMaterial(rhi)
    mat.poolSlot(0)
    mat.destroy()
    const afterFirst = destroyed().length
    mat.destroy()
    expect(destroyed().length).toBe(afterFirst)
    expect(afterFirst).toBe(created().length)
  })

  it('CONTROL — a material with no pool and no global uniform destroys only its pipelines', () => {
    // Without this arm, a `destroy()` that blindly called `destroyBuffer(undefined)` — or
    // one that released handles it never created — would pass the case above.
    const { rhi, created, destroyed } = recordingRhi()
    const mat = new Material(rhi, {
      shader: 'STUB',
      vsEntry: 'vs',
      fsEntry: 'fs',
      groups: [[{ binding: 0, kind: 'uniform' }]],
      variants: [{ label: 'only' }],
      colorTargets: [{ format: 'bgra8unorm' }],
      sampleCount: 1,
    } as never)
    expect(created().length, 'one pipeline, no buffers').toBe(1)
    mat.destroy()
    expect(destroyed()).toEqual(created())
  })

  it('CONTROL — bind groups and layouts are deliberately NOT released', () => {
    // `rhi.ts` documents them as GC-owned with no `destroy` — "the documented exception to
    // the create/destroy pairing" — and some layouts are caller-owned (the non-array branch
    // of the ctor's `groups` map). A destroy that reached for them would not compile today,
    // but pinning the intent stops someone adding `destroyBindGroup` and wiring it here.
    const { rhi, destroyed } = recordingRhi()
    const mat = makeMaterial(rhi)
    mat.poolSlot(0)
    mat.destroy()
    expect(destroyed().some((h) => h.startsWith('bg') || h.startsWith('layout'))).toBe(false)
  })

  it('poolSlot on a destroyed material throws instead of resurrecting slots (#2248)', () => {
    // destroy() empties poolBufs, so a draw flowing through a dead Material
    // would silently RE-CREATE slot buffers — and the idempotent second
    // destroy() early-returns, leaving the resurrection unreclaimed forever.
    const { rhi, created } = recordingRhi()
    const mat = makeMaterial(rhi)
    mat.poolSlot(0)
    mat.destroy()
    const before = created().length
    expect(() => mat.poolSlot(0)).toThrow(/destroyed/)
    expect(created().length, 'the throw fired BEFORE any create').toBe(before)
  })
})
