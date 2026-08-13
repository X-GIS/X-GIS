// ═══ Inc 6: the families whose key carries an AXIS — and the one that must not read ═══
//
// Increment 5 rewired the seven parameterless families, where the only way to be wrong was
// to pass no id. Increment 6 rewires the families whose baked key carries a pick flag or a
// stage entry, and the failure mode INVERTS: passing an id can now serve the WRONG BYTES.
//
// `wgsl-for.ts` returns a hit WITHOUT running the thunk. So a call site that hands over an
// id whose key does not describe what the thunk would have emitted gets a shader that
// compiles, links, renders — and is the wrong program. No pipeline error, no failing gate,
// just the wrong pixels. That is not hypothetical: `point-material.ts`'s own doc records
// exactly this having shipped once (passing null to the GLSL half "rendered the default
// silently on WebGL2: no crash, no failing pipeline, just the wrong colour").
//
// Three distinct hazards, three groups of arms:
//
//   G1 THE VARIANT GUARD. `wgsl/point` carries no variant token, so the bake may be read
//      ONLY when `shaderVariant === null`. A variant-carrying draper must fall through to
//      its thunk. Same for `rhi-fill-variant.ts`, which is variant-only and therefore
//      passes no id at all.
//
//   G2 THE ENTRY-CONST AGREEMENT. `emitPolygonGlslStages` defaults its entries with two
//      `??` in polygon.ts; `POLY_FILL` restates those same two names in ids.ts so a key can
//      be built for a call site that passes no entries. That is two authorities for one
//      fact, and ids.ts's own comment asks for a gate rather than trusting them. This is
//      that gate: change either `??` and every default-entry polygon site starts serving a
//      key that describes a different `main`.
//
//   G3 THE AXIS IDS RESOLVE. Same link-C claim increment 5 made, extended to the keys that
//      carry pick and entry tokens — the ones a transposition would move.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  POLY_FILL,
  POLY_PATTERN,
  POLY_STROKE,
  pickedModuleGlslId,
  pickedModuleWgslId,
  lineGlslId,
  lineWgslId,
  polygonGlslIds,
  polygonWgslId,
} from '../../shaders/baked/ids'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAP_SRC = join(HERE, '..', '..')
const read = (rel: string): string => readFileSync(join(MAP_SRC, rel), 'utf8')

function artifactIds(file: string): ReadonlySet<string> {
  const src = read(join('shaders', 'baked', file))
  const block = /index:\s*\{(.*?)\n\s{2}\}/s.exec(src)
  if (block === null) return new Set()
  return new Set([...block[1].matchAll(/'([^']+)':/g)].map((m) => m[1]))
}
const GLSL_BOOT = artifactIds('baked-glsl-boot.generated.ts')
const WGSL_BOOT = artifactIds('baked-wgsl-boot.generated.ts')

/** Call sites that deliberately pass NO id, with the reason. Shrink-only: if one of these
 *  ever gains a key that spells its axis, its entry goes and the rewiring lands here. */
const NOT_BAKED: Readonly<Record<string, string>> = {
  'render/rhi-fill-variant.ts':
    'builds the COMPOSED fill program (`emitPolygonWgsl(composed, …)`), and no baked key ' +
    'carries a composer variant — the closed set contains the variant-free program only. ' +
    'Reading the bake here would serve the default fill to a variant-carrying layer (#1679).',
}

describe('#1679 inc 6 — reader sanity', () => {
  it('the artifact indices and every scanned source were actually read', () => {
    expect(
      GLSL_BOOT.size,
      'the `index:` reader is broken, not the artifact',
    ).toBeGreaterThanOrEqual(20)
    expect(
      WGSL_BOOT.size,
      'the `index:` reader is broken, not the artifact',
    ).toBeGreaterThanOrEqual(10)
    for (const rel of [
      'render/material/point-material.ts',
      'render/material/raster-material.ts',
      'render/under-occluder-renderer.ts',
      'render/vector-tile-renderer.ts',
      'render/graticule-renderer.ts',
      'shaders/dsl/polygon.ts',
      ...Object.keys(NOT_BAKED),
    ])
      expect(
        read(rel).length,
        `${rel} read as empty — every arm over it would be vacuous`,
      ).toBeGreaterThan(500)
  })
})

describe('#1679 inc 6 — G1: the bake is read only where no variant is live', () => {
  it('point reads the bake ONLY under a `shaderVariant === null` guard', () => {
    const src = read('render/material/point-material.ts')
    // Both halves matter. The guard alone proves nothing if the ids are also passed
    // unconditionally somewhere else in the file, and the ids alone are the bug.
    expect(
      src,
      'point-material.ts no longer guards its baked ids on a null shaderVariant. `wgsl/point` ' +
        'carries NO variant token, and wgsl-for.ts returns a hit WITHOUT running the thunk — so a ' +
        'variant-carrying draper would receive the DEFAULT program while asking for the composed ' +
        'one. Wrong colour, no error. This exact failure is recorded in this file’s own ' +
        '`shaderVariant` doc comment as having shipped once already.',
    ).toContain('this.shaderVariant === null')
    // STRUCTURAL, not a regex over the call expression: an earlier version of this arm
    // used /wgslFor\([^)]*simpleWgslId\('point'\)\)/ and was VACUOUS — `[^)]*` stops at the
    // first `)`, which is the thunk's own (`emitPointWgsl(...)`), so it could never match the
    // real call shape. Cutting the guard left it green. Read the seam LINES instead.
    const seamLines = src
      .split('\n')
      .filter((l) => l.includes('wgslFor(') || l.includes('glslStagesFor('))
    expect(
      seamLines.length,
      'no wgslFor/glslStagesFor line found in point-material.ts — the scan is vacuous',
    ).toBeGreaterThanOrEqual(2)
    for (const line of seamLines)
      expect(
        /simple(Wgsl|Glsl)Id\(/.test(line),
        `point-material.ts passes a baked id DIRECTLY at the seam:\n    ${line.trim()}\n` +
          `Every id must reach the seam through the null-variant guard (\`bakedPointIds\`), or a ` +
          `variant-carrying draper gets the DEFAULT program while its thunk asked for the ` +
          `composed one — wrong colour, no error.`,
      ).toBe(false)
    for (const line of seamLines)
      expect(
        line.includes('bakedPointIds'),
        `a point seam call does not read the guarded id carrier:\n    ${line.trim()}\n` +
          `Both halves must go through \`bakedPointIds\`, which is undefined when a variant is live.`,
      ).toBe(true)
  })

  it('line reads the bake ONLY through its `variant === null` carrier', () => {
    const src = read('render/material/line-material.ts')
    // Same hazard and same structural form as the point arm above — deliberately NOT a
    // regex over the call expression, for the reason recorded there.
    const seamLines = src
      .split('\n')
      .filter((l) => l.includes('wgslFor(') || l.includes('glslFor('))
    expect(
      seamLines.length,
      'no wgslFor/glslFor line found in line-material.ts — the scan is vacuous',
    ).toBeGreaterThanOrEqual(4)
    for (const line of seamLines)
      expect(
        /line(Wgsl|Glsl)Id\(/.test(line),
        `line-material.ts passes a baked id DIRECTLY at the seam:\n    ${line.trim()}\n` +
          `The line keys carry pick and entry tokens but NO variant token, so a ` +
          `variant-carrying layer would be painted the variant-free stroke. Every id must ` +
          `come from bakedLineIds(), which returns undefined while a variant is live.`,
      ).toBe(false)
    expect(
      src,
      'bakedLineIds() no longer refuses to key a variant-carrying draper — that refusal IS ' +
        'the guard; without it the seam serves the wrong stroke colour with no error.',
    ).toContain('if (this.variant !== null) return undefined')
  })

  for (const [rel, reason] of Object.entries(NOT_BAKED)) {
    it(`${rel} passes no baked id at all`, () => {
      expect(reason, `NOT_BAKED['${rel}'] must cite the issue that explains it`).toMatch(/#\d+/)
      const src = read(rel)
      for (const builder of [
        'polygonWgslId(',
        'polygonGlslIds(',
        'simpleWgslId(',
        'pickedModuleWgslId(',
      ])
        expect(
          src.includes(builder),
          `${rel} now calls ${builder}…) — but it is on the NOT_BAKED list because ${reason} ` +
            `If that is no longer true, delete its entry in this same commit; if it is still ` +
            `true, this call site is serving bytes the thunk did not ask for.`,
        ).toBe(false)
    })
  }
})

describe('#1679 inc 6 — G2: the entry consts ARE the emitter defaults', () => {
  it('POLY_FILL restates emitPolygonGlslStages’ two `??` defaults exactly', () => {
    // ids.ts's POLY_FILL comment asks for precisely this: "a call site that passes no
    // entries and a key built from this const must resolve the same two `main`s, and
    // stating them here is what lets a gate pin that agreement instead of trusting two
    // `??` in another file." Nothing pinned it until now.
    const src = read('shaders/dsl/polygon.ts')
    const vtx = /vertexEntry:\s*entries\?\.vertex\s*\?\?\s*'([^']+)'/.exec(src)
    const frg = /fragmentEntry:\s*entries\?\.fragment\s*\?\?\s*'([^']+)'/.exec(src)
    expect(
      vtx && frg,
      'the `??` defaults in emitPolygonGlslStages could not be read — the regex, not the ' +
        'emitter, is what changed; this arm would otherwise pass vacuously',
    ).toBeTruthy()
    expect(
      { vertex: vtx?.[1], fragment: frg?.[1] },
      'POLY_FILL and emitPolygonGlslStages’ defaults have diverged. Every polygon call site ' +
        'that passes POLY_FILL builds its KEY from POLY_FILL while the emitter would lower a ' +
        'DIFFERENT pair of entries — so a store hit serves a program with the wrong `main`. ' +
        'Move both together, or make the emitter read POLY_FILL.',
    ).toEqual({ vertex: POLY_FILL.vertex, fragment: POLY_FILL.fragment })
  })

  it('the three entry consts name three DISTINCT pipelines', () => {
    // NOT "all six ids differ": POLY_FILL and POLY_PATTERN deliberately share the vertex
    // entry (`vs_main_ecef` — "same vertex entry, sprite-sampled fill"), so five distinct
    // ids across the three pairs is the CORRECT shape. What must never collapse is a
    // (vertex, fragment) PAIR, because that is what a key identifies: a copy-paste making
    // POLY_PATTERN equal POLY_FILL would point the pattern pipeline at the flat-fill bytes
    // and the sprite would simply vanish, with nothing failing.
    const pairs = [POLY_FILL, POLY_PATTERN, POLY_STROKE].map((e) => `${e.vertex}|${e.fragment}`)
    expect(
      new Set(pairs).size,
      `two polygon entry consts describe the SAME pipeline: ${pairs.join(', ')}. One of them ` +
        `would be served the other's program on every store hit.`,
    ).toBe(3)
    const fragments = [POLY_FILL, POLY_PATTERN, POLY_STROKE].map((e) => e.fragment)
    expect(
      new Set(fragments).size,
      `the three consts must differ in their FRAGMENT entry — that is what distinguishes a ` +
        `flat fill from a sprite fill from a stroke: ${fragments.join(', ')}`,
    ).toBe(3)
  })
})

describe('#1679 inc 6 — G3: every axis-carrying id resolves in the boot artifact', () => {
  for (const pick of [false, true])
    for (const family of ['raster', 'under-occluder'] as const)
      it(`${family} (pick=${pick}) resolves`, () => {
        expect(
          WGSL_BOOT.has(pickedModuleWgslId(family, pick)),
          pickedModuleWgslId(family, pick),
        ).toBe(true)
        for (const stage of ['vertex', 'fragment'] as const)
          expect(
            GLSL_BOOT.has(pickedModuleGlslId(family, pick, stage)),
            `${pickedModuleGlslId(family, pick, stage)} is absent from the committed GLSL boot ` +
              `artifact — the call site asks for it on every WebGL2 boot and the store answers ` +
              `'absent', so the bake is downloaded and ignored for this pipeline.`,
          ).toBe(true)
      })

  for (const [label, entries] of [
    ['fill', POLY_FILL],
    ['pattern', POLY_PATTERN],
    ['stroke', POLY_STROKE],
  ] as const)
    for (const pick of [false, true])
      it(`polygon ${label} (pick=${pick}) resolves`, () => {
        expect(WGSL_BOOT.has(polygonWgslId(pick)), polygonWgslId(pick)).toBe(true)
        const ids = polygonGlslIds(pick, entries)
        for (const [stage, id] of Object.entries(ids))
          expect(
            GLSL_BOOT.has(id),
            `${id} (polygon ${label}, ${stage}) is absent from the committed GLSL boot artifact. ` +
              `Either the entry const moved without the artifact being regenerated ` +
              `(bun run bake:shaders), or this entry pair is not in the closed set at all.`,
          ).toBe(true)
      })
})

describe('#1679 inc 7 — line: every keyed stage resolves in the boot artifact', () => {
  for (const pick of [false, true])
    it(`line (pick=${pick}) resolves for all four stage spellings`, () => {
      expect(WGSL_BOOT.has(lineWgslId(pick)), lineWgslId(pick)).toBe(true)
      for (const arg of ['vertex', 'fragment', 'fragment-pattern', 'fragment-max'] as const)
        expect(
          GLSL_BOOT.has(lineGlslId(pick, arg)),
          `${lineGlslId(pick, arg)} is absent from the committed GLSL boot artifact — the ` +
            `call site asks for it on every WebGL2 boot and the store answers 'absent'. ` +
            `LINE_GLSL_STAGES maps the emitter's stage ARGUMENT to the key, so an emitter ` +
            `that grew a stage without a row here falls through silently.`,
        ).toBe(true)
    })
})
