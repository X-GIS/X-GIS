// ═══ Baked shaders — the sync gate (#1678 phase A of #1484) ═══
//
// A committed artifact is a SECOND copy of something the emitters already know how to
// produce, and a second copy is a drift risk unless something proves the two agree on
// every commit. That is this file. Three gates, each failing for a different reason:
//
//   (a) HASH EQUALITY — per registry key, the baked bytes === a live emit RIGHT NOW,
//       byte-for-byte. This is the golden-sync: any emitter / optimizer / shader-graph
//       change that perturbs a single character shows up as a reviewed re-bake, not a
//       stale shader silently shipping.
//   (b) COMPLETENESS — the artifact index key set EQUALS the registry id set, both
//       directions. A key added to the registry without a re-bake goes red (missing);
//       a key deleted from the registry leaves an orphan that goes red too.
//   (c) META — the body consts baked into the artifact === the live ConstDecl values,
//       and the projection-graph fingerprint matches. The emitted sources embed
//       EARTH_R / WGS84_E2 / … as literals and splice the host-injected projection
//       graph, so a bake produced under a different planet or projection table is
//       wrong in a way (a) would also catch but (c) NAMES.
//
// Emit is byte-deterministic across processes (measured: six independent runs
// bit-identical), which is what makes rung-3 equality — not a tolerance, not a
// similarity score — the right gate here.
//
// RE-BAKE: `bun run bake:shaders` (from map/). This test deliberately has NO
// write-back/UPDATE mode: the committed script is the ONE regenerator, and a second
// one living in the gate is exactly the two-authorities drift the repo has paid for
// before.

import { describe, it, expect } from 'vitest'
import { PROJECTIONS } from '@xgis/geo'
import { configureProjections } from '../dsl/projections'
import { applyBodyOption } from '../../body-consts'
import {
  BAKED_SHADER_KEYS,
  bakedKeysFor,
  currentBakedMeta,
  type BakedArtifact,
  type BakedGroup,
  type BakedLanguage,
} from './registry'
import { BAKED_GLSL_HILLSHADE } from './baked-glsl-hillshade.generated'
import { BAKED_GLSL_REST } from './baked-glsl-rest.generated'
import { BAKED_WGSL_HILLSHADE } from './baked-wgsl-hillshade.generated'
import { BAKED_WGSL_REST } from './baked-wgsl-rest.generated'

// The same two host seams the bake script configures, in the same order — the gate
// must emit under EXACTLY the conditions the artifact was produced under. (The vitest
// setup file already calls configureProjections; repeating it here keeps this suite
// self-describing, as glsl-stage-entry-parity.test.ts does.)
configureProjections(PROJECTIONS)
applyBodyOption()

/** All FOUR committed files. Every gate below walks this table rather than the two
 *  languages: the split into (language, group) files is exactly the kind of change that
 *  can leave one artifact un-walked and vacuously green (#996), so the artifact a key
 *  belongs to is derived from the key itself — `key.group` — never assumed. */
const ARTIFACTS: Readonly<Record<BakedLanguage, Readonly<Record<BakedGroup, BakedArtifact>>>> = {
  glsl: { hillshade: BAKED_GLSL_HILLSHADE, rest: BAKED_GLSL_REST },
  wgsl: { hillshade: BAKED_WGSL_HILLSHADE, rest: BAKED_WGSL_REST },
}
const EVERY_ARTIFACT: ReadonlyArray<{
  language: BakedLanguage
  group: BakedGroup
  artifact: BakedArtifact
}> = (['glsl', 'wgsl'] as const).flatMap((language) =>
  (['hillshade', 'rest'] as const).map((group) => ({
    language,
    group,
    artifact: ARTIFACTS[language][group],
  })),
)
const REBAKE = 'run `bun run bake:shaders` (from map/) and commit the refreshed artifact'

/** Shader sources run to tens of thousands of characters; a raw `toBe` on two of them
 *  prints an unreadable wall. Report the FIRST differing line with both sides instead
 *  — that one line is what a reviewer needs to tell "the optimizer changed" from "the
 *  wrong planet was configured". */
function firstDiff(id: string, baked: string, live: string): string {
  const b = baked.split('\n')
  const l = live.split('\n')
  for (let i = 0; i < Math.max(b.length, l.length); i++) {
    if (b[i] === l[i]) continue
    return (
      `${id}: baked source drifted from the live emit at line ${i + 1} — ${REBAKE}\n` +
      `  baked: ${JSON.stringify(b[i] ?? '<end of baked source>')}\n` +
      `  live : ${JSON.stringify(l[i] ?? '<end of live emit>')}`
    )
  }
  return `${id}: sources differ (${baked.length} vs ${live.length} chars) with no differing line — ${REBAKE}`
}

describe('baked shaders — (a) hash equality: every baked source === a live emit', () => {
  // A DUPLICATE id silently shrinks the closed set: the second key overwrites the first
  // in the artifact index, and both completeness directions in (b) still pass because
  // the id set and the index key set are both sets. Only counting catches it.
  it('every registry id is unique (a dup shrinks the closed set invisibly)', () => {
    const seen = new Map<string, number>()
    for (const k of BAKED_SHADER_KEYS) seen.set(k.id, (seen.get(k.id) ?? 0) + 1)
    const dups = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`)
    expect(
      dups,
      `duplicate registry id(s) — one key's bytes would be baked over another's:\n${dups.join('\n')}`,
    ).toEqual([])
    expect(seen.size).toBe(BAKED_SHADER_KEYS.length)
  })

  for (const key of BAKED_SHADER_KEYS) {
    it(`${key.id}`, () => {
      const artifact = ARTIFACTS[key.language][key.group]
      const hash = artifact.index[key.id]
      expect(hash, `${key.id}: no entry in the baked index — ${REBAKE}`).toBeTypeOf('string')
      const baked = artifact.contents[hash as string]
      expect(
        baked,
        `${key.id}: index points at content hash ${hash} which the artifact does not carry — ${REBAKE}`,
      ).toBeTypeOf('string')
      const live = key.emit()
      expect(baked === live, firstDiff(key.id, baked as string, live)).toBe(true)
    })
  }
})

describe('baked shaders — (b) completeness: artifact index key set === registry id set', () => {
  for (const { language, group, artifact } of EVERY_ARTIFACT) {
    const what = `${language}/${group}`

    it(`${what}: every registry id is baked`, () => {
      const missing = bakedKeysFor(language, group)
        .map((k) => k.id)
        .filter((id) => artifact.index[id] === undefined)
      expect(
        missing,
        `${what}: ${missing.length} registry id(s) absent from the artifact — ${REBAKE}`,
      ).toEqual([])
    })

    it(`${what}: every baked id is still in the registry, IN THIS GROUP`, () => {
      // Scoped to the group, so moving a key between groups without a re-bake goes red
      // as an orphan here rather than silently shipping the source in both files.
      const known = new Set(bakedKeysFor(language, group).map((k) => k.id))
      const orphans = Object.keys(artifact.index).filter((id) => !known.has(id))
      expect(
        orphans,
        `${what}: ${orphans.length} baked id(s) no longer in this group — ${REBAKE}`,
      ).toEqual([])
    })

    it(`${what}: the content store is exactly what the index addresses`, () => {
      const referenced = new Set(Object.values(artifact.index))
      const stored = new Set(Object.keys(artifact.contents))
      const dangling = [...referenced].filter((h) => !stored.has(h))
      const unreferenced = [...stored].filter((h) => !referenced.has(h))
      expect(dangling, `${what}: index hashes with no stored content — ${REBAKE}`).toEqual([])
      expect(unreferenced, `${what}: stored content no index entry addresses — ${REBAKE}`).toEqual(
        [],
      )
    })

    it(`${what}: the key list is non-empty (registry growth forces a bake, not a skip)`, () => {
      expect(bakedKeysFor(language, group).length).toBeGreaterThan(0)
    })
  }

  it('the four artifacts partition the closed set — every key lands in exactly one file', () => {
    const baked = EVERY_ARTIFACT.flatMap(({ artifact }) => Object.keys(artifact.index))
    expect(
      baked.length,
      `${baked.length} baked entries across the four files vs ${BAKED_SHADER_KEYS.length} registry keys — ${REBAKE}`,
    ).toBe(BAKED_SHADER_KEYS.length)
    expect(new Set(baked).size, 'an id appears in more than one artifact file').toBe(baked.length)
  })
})

describe('baked shaders — (c) meta: the artifact records the body + projection graph it was baked under', () => {
  const live = currentBakedMeta()
  for (const { language, group, artifact } of EVERY_ARTIFACT) {
    const what = `${language}/${group}`

    it(`${what}: body consts match the live ConstDecl values`, () => {
      const { EARTH_R, EARTH_E2, WGS84_A, WGS84_E2 } = artifact.meta
      expect(
        { EARTH_R, EARTH_E2, WGS84_A, WGS84_E2 },
        `${what}: baked under a different body — the emitted sources embed these as literals; ${REBAKE}`,
      ).toEqual({
        EARTH_R: live.EARTH_R,
        EARTH_E2: live.EARTH_E2,
        WGS84_A: live.WGS84_A,
        WGS84_E2: live.WGS84_E2,
      })
    })

    it(`${what}: projection-graph fingerprint matches`, () => {
      expect(
        artifact.meta.projectionFingerprint,
        `${what}: baked against a different projection table — ${REBAKE}`,
      ).toBe(live.projectionFingerprint)
    })
  }

  it('all four artifacts agree with each other (one bake, four files)', () => {
    for (const { language, group, artifact } of EVERY_ARTIFACT)
      expect(
        artifact.meta,
        `${language}/${group} was baked in a different run — ${REBAKE}`,
      ).toEqual(BAKED_GLSL_HILLSHADE.meta)
  })
})
