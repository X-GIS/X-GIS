// ═══ Which region wins an overlap is RELEVANCE, not re-arm recency (#1602) ═══
//
// The drape draws one alpha-blended quad per resident region, so the LAST region drawn paints on
// top wherever two domains overlap. That order used to come from `states`, which is an LRU:
// `setCoverage` delete-then-sets, so the back is the most recently ARMED region. Since a per-region
// re-arm fires on every forecast tick and every playback frame, the overlap's winner changed
// several times a second — picked by recency, and disagreeing with the region `getCoverage(id, at)`
// reports for that same point.
//
// The right winner is already computed elsewhere: the catalogue ranks overlapping cells by overlap
// area with ties toward the SMALLER bbox (`itemsForView` — "Preferring the smaller bbox picks the
// higher-resolution local cell"), and arms them in that order. So the region's index in the
// `_coverage` Map IS its relevance, and it is the same index `coverageHandleAt` and the advected
// arrows resolve by. Drawing most-relevant LAST makes the paint agree with the readout.
//
// The eviction LRU is deliberately untouched — least-recently-USED is still the right thing to
// evict. One Map served both orders until they started wanting opposite directions.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageFromGrids, type CoverageInput } from '@xgis/data'
import { CoverageRenderer } from './coverage-renderer'

function makeMockCtx(): { ctx: unknown } {
  const tex = () => ({ destroy() {}, __tex: true })
  return {
    ctx: {
      rhi: {
        backend: 'webgpu',
        createTexture: tex,
        createView: () => ({ __view: true }),
        createSampler: () => ({ __samp: true }),
        writeTexture: () => {},
        destroyTexture: () => {},
        createBuffer: () => ({ __buf: true }),
        writeBuffer: () => {},
        destroyBuffer: () => {},
        createBindGroupLayout: () => ({ __layout: true }),
        createPipeline: () => ({ __pipe: true }),
        createBindGroup: () => ({ __bg: true }),
        caps: { shaderLanguage: 'wgsl' },
      },
      canvas: { width: 800, height: 600 },
    },
  }
}

function handleOf(originLon: number): ReturnType<typeof coverageFromGrids> {
  const input: CoverageInput = {
    product: 's111',
    origin: [originLon, 50],
    spacing: [1, 1],
    size: [4, 4],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(Array.from({ length: 16 }, (_, i) => (i % 5) + 1)),
      },
    ],
  }
  return coverageFromGrids(input)
}

const makeRenderer = (): CoverageRenderer =>
  new CoverageRenderer(
    makeMockCtx().ctx as unknown as ConstructorParameters<typeof CoverageRenderer>[0],
  )

/** The regions the REAL `render()` loop draws, in the order it draws them.
 *
 *  Driven rather than inspected. An earlier cut of this file called `drawOrder()` directly and was
 *  green either way — reverting the loop to `states.values()` did not redden a single behavioural
 *  test, because a helper returning the right list says nothing about whether the draw consumes it.
 *  That is the #1587 shape exactly. So this stubs the ONE collaborator the loop reaches per region
 *  (`draperFor`), records the state it is handed, and lets everything else be real. */
function drawKeys(r: CoverageRenderer): string[] {
  const priv = r as unknown as {
    draperFor(s: { valueTex: unknown }): unknown
    states: Map<string, { valueTex: unknown }>
  }
  const byTex = new Map([...priv.states].map(([k, s]) => [s.valueTex, k]))
  const seen: string[] = []
  const real = priv.draperFor
  priv.draperFor = (s) => {
    seen.push(byTex.get(s.valueTex) ?? '?')
    // The two members the loop reaches: `groupFor` asks for a bind group, then it draws.
    return { bindGroup: () => ({ __bg: true }), draw() {} }
  }
  try {
    r.render({ __pass: true } as never, new Float32Array(16), [0, 0], [0, 0, 0, 0])
  } finally {
    priv.draperFor = real
  }
  return seen
}

const RAMP = { ramp: 's111-speed' }

describe('coverage drape draw order — relevance, not recency (#1602)', () => {
  it('the MOST relevant region is drawn LAST, so it lands on top of the overlap', () => {
    // priority 0 = most relevant (the local, higher-resolution cell). Under alpha-over, last wins.
    // NOTE: this arms in relevance order, so the old LRU order happened to agree — it states the
    // claim plainly but passes either way. The DISCRIMINATING cases are the next two.
    const r = makeRenderer()
    r.setCoverage(handleOf(10), { ...RAMP, priority: 1 }, 'wcofs') // basin-wide, coarse
    r.setCoverage(handleOf(11), { ...RAMP, priority: 0 }, 'sfbofs') // local, fine
    expect(drawKeys(r)).toEqual(['wcofs', 'sfbofs'])
  })

  it('…whatever order they were ARMED in', () => {
    // Arm order is normally relevance order, but a deferred load or a push can land out of order.
    // The winner must follow the priority, not the arrival.
    const r = makeRenderer()
    r.setCoverage(handleOf(11), { ...RAMP, priority: 0 }, 'sfbofs')
    r.setCoverage(handleOf(10), { ...RAMP, priority: 1 }, 'wcofs')
    expect(drawKeys(r)).toEqual(['wcofs', 'sfbofs'])
  })

  it('A RE-ARM DOES NOT CHANGE THE WINNER — this is the reported symptom', () => {
    // THE BUG. A forecast tick re-arms one region, which moves it to the back of the LRU. When the
    // LRU was the draw order, that alone handed it the overlap: the coarse basin cell painted over
    // the fine local one for a tick, then back, several times a second.
    const r = makeRenderer()
    r.setCoverage(handleOf(11), { ...RAMP, priority: 0 }, 'sfbofs')
    r.setCoverage(handleOf(10), { ...RAMP, priority: 1 }, 'wcofs')
    const before = drawKeys(r)

    r.setCoverage(handleOf(10), { ...RAMP, priority: 1 }, 'wcofs') // wcofs steps its forecast hour
    expect(drawKeys(r), 'the less relevant region re-armed; it must NOT take the top').toEqual(
      before,
    )

    r.setCoverage(handleOf(11), { ...RAMP, priority: 0 }, 'sfbofs') // and the other one steps too
    expect(drawKeys(r)).toEqual(before)
  })

  it('the EVICTION LRU is untouched — recency still decides what gets dropped', () => {
    // The two orders are now separate on purpose, and this pins that the split did not quietly
    // rewrite eviction. `residentRegions()` is the LRU view: re-arming moves a region to the back,
    // where the evictor looks last.
    const r = makeRenderer()
    r.setCoverage(handleOf(11), { ...RAMP, priority: 0 }, 'sfbofs')
    r.setCoverage(handleOf(10), { ...RAMP, priority: 1 }, 'wcofs')
    expect(r.residentRegions()).toEqual(['sfbofs', 'wcofs'])

    r.setCoverage(handleOf(11), { ...RAMP, priority: 0 }, 'sfbofs')
    expect(r.residentRegions(), 're-arm still refreshes LRU recency').toEqual(['wcofs', 'sfbofs'])
    // …while the draw order, which must not follow recency, has not moved.
    expect(drawKeys(r)).toEqual(['wcofs', 'sfbofs'])
  })

  it('one region, or equal priorities, keeps arm order — the single-region path is unchanged', () => {
    const r = makeRenderer()
    r.setCoverage(handleOf(10), RAMP, 'only')
    expect(drawKeys(r)).toEqual(['only'])

    const r2 = makeRenderer()
    r2.setCoverage(handleOf(10), RAMP, 'a') // both default to priority 0
    r2.setCoverage(handleOf(11), RAMP, 'b')
    expect(drawKeys(r2), 'a stable sort leaves equal priorities in arm order').toEqual(['a', 'b'])
  })
})

describe('the draw loop actually consumes drawOrder() (#1602)', () => {
  // A correct ordering function nobody calls is worth nothing — #1587 was exactly that shape (a
  // prefetch pump with green unit tests over a call site that could never reach it). The draw loop
  // needs a built draper and a live pass to run, so the consumption is pinned against the source.
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'coverage-renderer.ts'),
    'utf8',
  )

  it('iterates drawOrder(), not states.values(), in the draw loop', () => {
    expect(
      SOURCE,
      'the draw loop must consume the relevance order — iterating `states` directly is the bug',
    ).toContain('for (const s of this.drawOrder())')
    // And nothing else may walk `states` to draw. The three remaining `states.values()` walks are
    // the flow-field probe, the flow-field pick and the byte total — none of them a draw order.
    // Pinned so a fourth has to be looked at rather than assumed harmless.
    expect(
      SOURCE.split('of this.states.values()').length - 1,
      'a new states.values() walk appeared — is it deciding draw order again?',
    ).toBe(3)
  })
})
