// ═══ RHI create↔destroy symmetry ratchet (#2248, ownership P0) ═══
//
// #782 shipped the RhiDevice interface with `create*` ×7 and `destroyBuffer`
// alone — every other resource type leaked (WebGL2) or leaned on GC (WebGPU)
// with nothing saying which was intended. The fix added destroyTexture /
// destroySampler / destroyPipeline and DOCUMENTED the GC-owned exceptions,
// but nothing has guarded the pairing since: a future `createX` with no
// `destroyX` and no documented GC-tier entry would land silently — the exact
// asymmetry #782 paid to close.
//
// This ratchet reads `rhi.ts` and asserts every create/destroy method pairs
// or is on the GC-tier allowlist. Per the §12 path-keyed-gate lesson, the
// allowlist carries a companion assertion: every GC-tier key must still
// resolve to a real `create*`, so a renamed/removed method reddens the gate
// instead of leaving a vacuously-green stale key. The checker is a pure
// function, proven non-vacuous below against synthetic violating sources.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/** Resource types whose handles are deliberately GC-owned with no `destroy*`,
 *  as documented in rhi.ts ("the documented exception to the create/destroy
 *  pairing"): texture views (WebGL2: the view IS the texture; WebGPU:
 *  GC-owned), bind groups + layouts (WebGL2: plain JS records; WebGPU:
 *  GC-owned), and command encoders (one encoder = one submit, structurally
 *  transient). Adding a `createX` for anything else requires a `destroyX` —
 *  or a conscious entry here WITH the matching doc in rhi.ts. */
const GC_TIER = ['View', 'BindGroupLayout', 'BindGroup', 'CommandEncoder'] as const

interface SymmetryAudit {
  /** X for every `createX` declaration found. */
  creates: string[]
  /** X for every `destroyX` declaration found. */
  destroys: string[]
  /** `createX` with neither a `destroyX` nor a GC-tier entry. */
  unpairedCreates: string[]
  /** `destroyX` with no `createX` (an orphan destroy). */
  orphanDestroys: string[]
  /** GC-tier keys that no longer resolve to a `createX` (stale allowlist). */
  staleTierKeys: string[]
}

/** Scan interface-method declarations (2-space indent, optional `?`) for
 *  `create[A-Z]…` / `destroy[A-Z]…` names and audit the pairing. The bare
 *  whole-device `destroy()` is excluded by the [A-Z] requirement — it is the
 *  teardown keystone, not a per-resource pair. Doc-comment prose never
 *  matches: comment lines carry `*` or `//` between the indent and the word. */
function auditSymmetry(source: string, gcTier: readonly string[]): SymmetryAudit {
  const decl = /^ {2}(create|destroy)([A-Z]\w*)\??\(/gm
  const creates: string[] = []
  const destroys: string[] = []
  for (const m of source.matchAll(decl)) {
    ;(m[1] === 'create' ? creates : destroys).push(m[2]!)
  }
  const createSet = new Set(creates)
  const destroySet = new Set(destroys)
  return {
    creates,
    destroys,
    unpairedCreates: creates.filter((x) => !destroySet.has(x) && !gcTier.includes(x)),
    orphanDestroys: destroys.filter((x) => !createSet.has(x)),
    staleTierKeys: gcTier.filter((x) => !createSet.has(x)),
  }
}

const rhiSource = readFileSync(new URL('../../rhi/src/rhi.ts', import.meta.url), 'utf8')

describe('RHI create↔destroy symmetry ratchet (#2248)', () => {
  it('every create* on the live surface pairs with a destroy* or a documented GC-tier entry', () => {
    const audit = auditSymmetry(rhiSource, GC_TIER)
    expect(audit.unpairedCreates, 'create* without destroy* or GC-tier doc').toEqual([])
    expect(audit.orphanDestroys, 'destroy* whose create* is gone').toEqual([])
    expect(audit.staleTierKeys, 'GC-tier allowlist key no longer resolves (§12)').toEqual([])
  })

  it('ratchet: the surface is exactly the audited 2026-09 set — change it consciously', () => {
    // Adding/removing a create* or destroy* MUST update this list (and, for a
    // new GC-owned type, the rhi.ts doc + GC_TIER above) in the same PR — the
    // diff is the record that the lifetime story was decided, not defaulted.
    const audit = auditSymmetry(rhiSource, GC_TIER)
    expect([...audit.creates].sort()).toEqual(
      [
        'BindGroup',
        'BindGroupLayout',
        'Buffer',
        'CommandEncoder',
        'Pipeline',
        'Sampler',
        'Texture',
        'View',
      ].sort(),
    )
    expect([...audit.destroys].sort()).toEqual(['Buffer', 'Pipeline', 'Sampler', 'Texture'].sort())
  })

  it('NON-VACUITY — an unpaired create is flagged', () => {
    const bad = '  createFoo(desc: FooDesc): Foo\n  destroyBuffer(b: RhiBuffer): void\n'
    expect(auditSymmetry(bad, GC_TIER).unpairedCreates).toEqual(['Foo'])
  })

  it('NON-VACUITY — an orphan destroy is flagged', () => {
    const bad = '  destroyBar(b: Bar): void\n'
    expect(auditSymmetry(bad, GC_TIER).orphanDestroys).toEqual(['Bar'])
  })

  it('NON-VACUITY — a stale GC-tier key is flagged (§12 path-keyed-gate companion)', () => {
    const src =
      '  createBuffer(desc: RhiBufferDesc): RhiBuffer\n  destroyBuffer(b: RhiBuffer): void\n'
    expect(auditSymmetry(src, ['Ghost']).staleTierKeys).toEqual(['Ghost'])
  })

  it('CONTROL — doc-comment prose naming createX/destroyX never matches the scanner', () => {
    const src =
      '  /** prefer `createBuffer` over reaching behind the handle */\n   *  createTexture is documented above\n'
    const audit = auditSymmetry(src, GC_TIER)
    expect(audit.creates).toEqual([])
    expect(audit.destroys).toEqual([])
  })
})
