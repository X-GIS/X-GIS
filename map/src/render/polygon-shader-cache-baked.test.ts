// ═══ #2499 — the WebGPU polygon base shader READS its bake ═══
//
// `wgsl/polygon/{pick,nopick}` was baked in #1679 and downloaded by every WebGPU boot, and
// `polygonWgslId` had no consumer: the WebGPU polygon path is `PipelineFactory.build()` →
// `buildShader(null)` → `emitPolygonWgsl`, which never went through `wgslFor`. The boot
// provenance gate (`playground/e2e/_2499-boot-shader-provenance-gate.spec.ts`) saw the
// result at the driver — the 26 KB base program handed to Tint 17× from runtime-emitted
// text. These arms pin the seam contract on `buildShader` itself, the way
// `wgsl-for-baked.test.ts` pins it on the helpers: the store answers first, a miss is
// `shipSource(emit)` so both provenances serve the same text, and a composer variant —
// the open set — never touches the store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EARTH, MOON, configureBody } from '@xgis/shared'
import { isPickEnabled } from '@xgis/engine'
import { configureBodyConsts } from '../body-consts'
import { emitPolygonWgsl } from '../shaders/dsl/polygon'
import { polygonWgslId } from '../shaders/baked/ids'
import { BAKED_WGSL_BOOT } from '../shaders/baked/baked-wgsl-boot.generated'
import { _resetBakedStore, bakedStoreStats, mergeBakedSources } from '../shaders/baked/store'
import { shipSource } from './material/wgsl-for'
import { buildShader, toComposerVariant } from './polygon-shader-cache'
import type { ShaderVariantInfo } from './renderer-types'

/** Apply a body the way the XGISMap ctor does (see body-blind-caches.test.ts). */
function switchBody(body: typeof EARTH): void {
  configureBody(body)
  configureBodyConsts(body)
}

const id = (): string => polygonWgslId(isPickEnabled())
const bakedBytes = (): string => {
  const hash = BAKED_WGSL_BOOT.index[id()]
  const src = hash === undefined ? undefined : BAKED_WGSL_BOOT.contents[hash]
  expect(src, `${id()} must be in the committed WGSL boot artifact`).toBeDefined()
  return src!
}

beforeEach(() => {
  switchBody(EARTH)
  _resetBakedStore()
})
afterEach(() => {
  switchBody(EARTH)
  _resetBakedStore()
})

describe('#2499 — buildShader(null) and the baked store', () => {
  it('sanity: the baked bytes are NOT the raw emit (else a hit and a miss are indistinguishable)', () => {
    // The artifact stores `shipSource(emit)` — one line; the raw emit is many. If these
    // were ever equal, every arm below would pass without the store being asked.
    expect(bakedBytes()).not.toBe(emitPolygonWgsl(null, isPickEnabled()))
  })

  it('with the boot artifact installed, the base shader IS the baked bytes and the store records a hit', () => {
    mergeBakedSources(BAKED_WGSL_BOOT)
    const before = bakedStoreStats().hits
    expect(buildShader(null)).toBe(bakedBytes())
    expect(bakedStoreStats().hits, 'the lookup went through the store').toBe(before + 1)
    expect(bakedStoreStats().misses).toBe(0)
  })

  it('with nothing installed, a miss serves shipSource(emit) — the same text a hit would', () => {
    const miss = buildShader(null)
    expect(miss).toBe(shipSource(emitPolygonWgsl(null, isPickEnabled())))
    // baked-sync pins artifact === shipSource(live emit); this is the same equality read
    // from the seam's side, so hit and miss provenance cannot serve different programs.
    expect(miss).toBe(bakedBytes())
    expect(bakedStoreStats().absent, 'an uninstalled family reads ABSENT, never a miss').toBe(1)
  })

  it('a variant that composes to null shares the base bytes (memo key differs, bytes do not)', () => {
    mergeBakedSources(BAKED_WGSL_BOOT)
    const plain = {
      key: 'plain-variant',
      needsFeatureBuffer: false,
    } as unknown as ShaderVariantInfo
    expect(toComposerVariant(plain), 'premise: this variant composes to null').toBeNull()
    expect(buildShader(plain)).toBe(bakedBytes())
  })

  it('on the Moon the store is CLOSED and the emit answers — never the Earth bake', () => {
    mergeBakedSources(BAKED_WGSL_BOOT)
    const earth = buildShader(null)
    switchBody(MOON)
    const moon = buildShader(null)
    expect(moon).not.toBe(earth)
    expect(bakedStoreStats().closed, 'the body guard closed the lookup').toBeGreaterThan(0)
    expect(moon).toBe(shipSource(emitPolygonWgsl(null, isPickEnabled())))
  })
})
