// ═══ Baked shaders — the id GRAMMAR is the registry's id set (#1679 increment 1) ═══
//
// `ids.ts` is now the ONE authority for every baked id, and `registry.ts` calls it. That
// is only worth anything if the two really do describe the same set of strings — a
// builder that drops a token, or a domain constant that lost a member, would produce a
// grammar that is a strict SUBSET of what the registry bakes, and every existing gate
// would stay green: `baked-sync.test.ts` walks `BAKED_SHADER_KEYS`, so whatever the
// registry spells is what it checks, and `seed-hillshade.ts` only ever asks for the ten
// hillshade ids. The hole this file closes is therefore invisible everywhere else: an id
// the CONSUME side builds and the BAKE side never wrote is a permanent miss, and a miss
// silently falls back to a runtime emit — the exact behaviour the bake is an optimisation
// over, so nothing goes red and nothing renders wrong. Only a set comparison sees it.
//
// Four properties, each failing for a different reason:
//
//   (a) EQUALITY, both directions — every id the builders can produce over their FULL
//       argument domain is a registry id, and every registry id is producible. Not a
//       subset either way.
//   (b) INJECTIVITY — no two distinct argument tuples produce the same string. This is
//       the trap that kills a naive grammar: `shaderRequestKey` interpolates `methodFlag`
//       unconditionally, and that same shape here would fold polygon's five stage entries
//       onto one key and serve one shader's bytes under another's name (#1679's rejected
//       "widen ShaderEmitRequest" alternative).
//   (c) TOKEN HYGIENE — no id carries the literal `"undefined"` and none has an empty
//       segment. `${undefined}` stringifies to a token that looks perfectly valid, which
//       is why the grammar appends conditionally instead of interpolating.
//   (d) THE ENTRY CONSTS resolve the emitter's own defaults — `POLY_FILL` spells
//       `vs_main_ecef` / `fs_fill` explicitly, and `emitPolygonGlslStages` applies those
//       same two via `??`. A call site that passes no entries and an id built from
//       `POLY_FILL` must therefore address the same bytes; that agreement is pinned here
//       by BYTE equality, not by trusting two `??` in another file.
//
// Plus the leaf property `ids.ts`'s whole design rests on: it imports NOTHING. Gate 9 of
// `architecture-invariants.test.ts` stops a runtime module from value-importing
// `registry.ts` (and with it all 24 dsl emitters); `ids.ts` is what those modules import
// INSTEAD, so an import added here would route the emitters straight back into the
// bundle, past a gate that is not looking at this file.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECTIONS } from '@xgis/geo'
import { configureProjections } from '../dsl/projections'
import { applyBodyOption } from '../../body-consts'
import { emitPolygonGlslStages } from '../dsl/polygon'
import { BAKED_SHADER_KEYS } from './registry'
import {
  BAKED_STAGES,
  HILLSHADE_METHOD_FLAGS,
  LINE_GLSL_STAGES,
  LINE_GLSL_STAGE_ARGS,
  OIT_SAMPLE_COUNTS,
  PICKED_MODULE_FAMILIES,
  PICK_STATES,
  POLYGON_FRAGMENT_ENTRIES,
  POLYGON_VERTEX_ENTRIES,
  POLY_FILL,
  POLY_PATTERN,
  POLY_STROKE,
  SIMPLE_FAMILIES,
  WGSL_ONLY_FAMILIES,
  hillshadeGlslId,
  hillshadeWgslId,
  lineGlslId,
  lineWgslId,
  oitComposeWgslId,
  pickedModuleGlslId,
  pickedModuleWgslId,
  polygonGlslFragmentId,
  polygonGlslIds,
  polygonGlslVertexId,
  polygonWgslId,
  simpleGlslId,
  simpleWgslId,
  wgslOnlyId,
} from './ids'

// The polygon byte pin below emits, so the same two host seams `baked-sync.test.ts`
// configures, in the same order.
configureProjections(PROJECTIONS)
applyBodyOption()

/** One id together with the CALL that produced it — the call text is what makes an
 *  injectivity failure readable ("these two tuples collapse") rather than "duplicate". */
interface Produced {
  readonly id: string
  readonly from: string
}

/** Every builder over its FULL argument domain, walked from the domain constants
 *  `ids.ts` exports — not from a list re-typed here, which would be a third authority
 *  and could go stale in exactly the direction (a) exists to catch. */
function enumerateGrammar(): Produced[] {
  const out: Produced[] = []
  const add = (id: string, from: string): void => {
    out.push({ id, from })
  }

  for (const methodFlag of HILLSHADE_METHOD_FLAGS)
    for (const pick of PICK_STATES) {
      add(hillshadeWgslId(methodFlag, pick), `hillshadeWgslId(${methodFlag}, ${pick})`)
      for (const stage of BAKED_STAGES)
        add(
          hillshadeGlslId(methodFlag, pick, stage),
          `hillshadeGlslId(${methodFlag}, ${pick}, '${stage}')`,
        )
    }

  for (const pick of PICK_STATES) {
    add(polygonWgslId(pick), `polygonWgslId(${pick})`)
    for (const entry of POLYGON_VERTEX_ENTRIES)
      add(polygonGlslVertexId(pick, entry), `polygonGlslVertexId(${pick}, '${entry}')`)
    for (const entry of POLYGON_FRAGMENT_ENTRIES)
      add(polygonGlslFragmentId(pick, entry), `polygonGlslFragmentId(${pick}, '${entry}')`)

    add(lineWgslId(pick), `lineWgslId(${pick})`)
    for (const arg of LINE_GLSL_STAGE_ARGS)
      add(lineGlslId(pick, arg), `lineGlslId(${pick}, '${arg}')`)

    for (const family of PICKED_MODULE_FAMILIES) {
      add(pickedModuleWgslId(family, pick), `pickedModuleWgslId('${family}', ${pick})`)
      for (const stage of BAKED_STAGES)
        add(
          pickedModuleGlslId(family, pick, stage),
          `pickedModuleGlslId('${family}', ${pick}, '${stage}')`,
        )
    }
  }

  for (const family of SIMPLE_FAMILIES) {
    add(simpleWgslId(family), `simpleWgslId('${family}')`)
    for (const stage of BAKED_STAGES)
      add(simpleGlslId(family, stage), `simpleGlslId('${family}', '${stage}')`)
  }

  for (const family of WGSL_ONLY_FAMILIES)
    for (const pick of PICK_STATES)
      add(wgslOnlyId(family, pick), `wgslOnlyId('${family}', ${pick})`)
  for (const n of OIT_SAMPLE_COUNTS) add(oitComposeWgslId(n), `oitComposeWgslId(${n})`)

  return out
}

/** Members of `a` that `b` does not carry. Extracted so the #996 arm can probe that it
 *  actually distinguishes two different sets. */
const missingFrom = (a: readonly string[], b: readonly string[]): string[] => {
  const have = new Set(b)
  return [...new Set(a)].filter((x) => !have.has(x)).sort()
}

const PRODUCED = enumerateGrammar()
const PRODUCED_IDS = PRODUCED.map((p) => p.id)
const REGISTRY_IDS = BAKED_SHADER_KEYS.map((k) => k.id)

describe('baked ids — (a) the grammar produces EXACTLY the registry id set', () => {
  it('every id a builder can produce is baked', () => {
    const orphans = missingFrom(PRODUCED_IDS, REGISTRY_IDS)
    expect(
      orphans,
      `these ids are reachable from ids.ts's builders but BAKED_SHADER_KEYS does not carry ` +
        `them — a call site that keys on one gets a permanent MISS (a silent fall-back to a ` +
        `runtime emit, which no other gate can see). Either registry.ts's buildKeys lost a row ` +
        `or a domain constant in ids.ts grew a member the registry does not bake:\n` +
        orphans.join('\n'),
    ).toEqual([])
  })

  it('every baked id is reachable from a builder', () => {
    const unreachable = missingFrom(REGISTRY_IDS, PRODUCED_IDS)
    expect(
      unreachable,
      `BAKED_SHADER_KEYS carries these ids but no builder in ids.ts can spell them — the ` +
        `registry is building a key inline again (the two-authority condition increment 1 ` +
        `removed), or a builder dropped a token / a domain constant lost a member:\n` +
        unreachable.join('\n'),
    ).toEqual([])
  })

  it('the two sets are the same SIZE (a duplicate would hide inside set equality)', () => {
    expect(new Set(PRODUCED_IDS).size).toBe(PRODUCED_IDS.length)
    expect(new Set(REGISTRY_IDS).size).toBe(REGISTRY_IDS.length)
    expect(PRODUCED_IDS.length).toBe(REGISTRY_IDS.length)
  })
})

describe('baked ids — (b) injectivity: distinct arguments, distinct id', () => {
  it('no two argument tuples produce the same string', () => {
    const byId = new Map<string, string[]>()
    for (const { id, from } of PRODUCED) byId.set(id, [...(byId.get(id) ?? []), from])
    const collisions = [...byId]
      .filter(([, froms]) => froms.length > 1)
      .map(([id, froms]) => `${id} ← ${froms.join('  ==  ')}`)
    expect(
      collisions,
      `two different shaders share one id. Whichever is baked second overwrites the first in ` +
        `the artifact index, so a lookup serves ONE shader's bytes under the OTHER's name — ` +
        `wrong pixels, and every count-based gate still passes:\n${collisions.join('\n')}`,
    ).toEqual([])
  })

  // Cut the specific mechanism (CLAUDE.md §12): a grammar that appended no entry token, or
  // no method token, would fail EXACTLY here and nowhere else — the counts would still be
  // right, the ids would still be well-formed, and (a) would still pass in the direction
  // that matters least. Each expectation below names the token whose loss it detects.
  it('the ENTRY token separates polygon’s five draper-selectable stage entries', () => {
    const vertex = POLYGON_VERTEX_ENTRIES.map((e) => polygonGlslVertexId(false, e))
    const fragment = POLYGON_FRAGMENT_ENTRIES.map((e) => polygonGlslFragmentId(false, e))
    expect(
      new Set([...vertex, ...fragment]).size,
      `polygon's ${vertex.length} vertex + ${fragment.length} fragment entries must be ` +
        `${vertex.length + fragment.length} distinct ids; drop the entry token and fs_stroke ` +
        `resolves to the fs_fill bytes`,
    ).toBe(vertex.length + fragment.length)
  })

  it('the ENTRY token separates line’s four stage arguments', () => {
    const ids = LINE_GLSL_STAGE_ARGS.map((a) => lineGlslId(true, a))
    expect(new Set(ids).size, `line's ${ids.length} stage arguments collapsed: ${ids}`).toBe(
      ids.length,
    )
  })

  it('the METHOD token separates hillshade’s five method fragments', () => {
    const ids = HILLSHADE_METHOD_FLAGS.map((m) => hillshadeWgslId(m, false))
    expect(
      new Set(ids).size,
      `the m<flag> token is not load-bearing — all five hillshade methods would serve the ` +
        `same source: ${ids}`,
    ).toBe(HILLSHADE_METHOD_FLAGS.length)
  })

  it('the PICK token flips the id on every family that has the dimension', () => {
    expect(polygonWgslId(false)).not.toBe(polygonWgslId(true))
    expect(lineWgslId(false)).not.toBe(lineWgslId(true))
    expect(hillshadeWgslId(3, false)).not.toBe(hillshadeWgslId(3, true))
    expect(pickedModuleWgslId('raster', false)).not.toBe(pickedModuleWgslId('raster', true))
    expect(polygonGlslFragmentId(false, 'fs_fill')).not.toBe(polygonGlslFragmentId(true, 'fs_fill'))
    expect(wgslOnlyId('line-split', false)).not.toBe(wgslOnlyId('line-split', true))
  })

  it('the SAMPLE-COUNT token separates oit-compose’s three MSAA unrolls', () => {
    expect(new Set(OIT_SAMPLE_COUNTS.map(oitComposeWgslId)).size).toBe(OIT_SAMPLE_COUNTS.length)
  })
})

describe('baked ids — (c) token hygiene: nothing is interpolated from undefined', () => {
  it('no id carries the literal "undefined" or an empty segment', () => {
    const malformed = PRODUCED.filter(({ id }) => {
      const parts = id.split('/')
      return parts.some((p) => p === '' || p === 'undefined')
    }).map(({ id, from }) => `${from} → ${JSON.stringify(id)}`)
    expect(
      malformed,
      `an absent axis was INTERPOLATED instead of appended. \`\${undefined}\` yields the token ` +
        `"undefined", which reads as valid and collapses families onto one key:\n` +
        malformed.join('\n'),
    ).toEqual([])
  })

  it('a family with no pick / method dimension emits no token for it', () => {
    // The positive control for the conditional append: `simpleWgslId` passes both optional
    // axes as absent, so the id must be exactly two tokens.
    expect(simpleWgslId('text')).toBe('wgsl/text')
    expect(simpleGlslId('heatmap-blur', 'vertex')).toBe('glsl/heatmap-blur/vertex')
    // …and the same builders under a family that DOES carry them still spell them.
    expect(hillshadeGlslId(3, true, 'fragment')).toBe('glsl/hillshade/m3/pick/fragment')
    expect(pickedModuleGlslId('under-occluder', false, 'vertex')).toBe(
      'glsl/under-occluder/nopick/vertex',
    )
    expect(polygonGlslFragmentId(false, 'fs_stroke')).toBe('glsl/polygon/nopick/fragment/fs_stroke')
    expect(lineGlslId(true, 'fragment-pattern')).toBe('glsl/line/pick/fragment/fs_line_pattern')
    // The WGSL-only shapes (#2499): pick only, and the sample-count token only.
    expect(wgslOnlyId('polygon-split', true)).toBe('wgsl/polygon-split/pick')
    expect(oitComposeWgslId(4)).toBe('wgsl/oit-compose/s4')
  })
})

describe('baked ids — (d) the shared entry consts are the emitter’s own defaults', () => {
  it('POLY_FILL emits byte-identically to passing no entries at all', () => {
    // The whole point of spelling the defaults explicitly: a draper that calls
    // `emitPolygonGlslStages(null, pick)` and keys on `polygonGlslIds(pick, POLY_FILL)`
    // must be addressing these exact bytes. If polygon.ts's `?? 'vs_main_ecef'` /
    // `?? 'fs_fill'` ever change, this is the assertion that says so — the id would keep
    // resolving, to the WRONG source.
    const byDefault = emitPolygonGlslStages(null, false)
    const explicit = emitPolygonGlslStages(null, false, POLY_FILL)
    expect(
      explicit.vertex === byDefault.vertex,
      `POLY_FILL.vertex ('${POLY_FILL.vertex}') is no longer emitPolygonGlslStages' default ` +
        `vertex entry — update POLY_FILL to whatever polygon.ts now defaults to, or the ` +
        `baked id and the emitted bytes have parted company`,
    ).toBe(true)
    expect(
      explicit.fragment === byDefault.fragment,
      `POLY_FILL.fragment ('${POLY_FILL.fragment}') is no longer emitPolygonGlslStages' ` +
        `default fragment entry`,
    ).toBe(true)
  })

  it('every entry const addresses ids the closed set actually bakes', () => {
    const baked = new Set(REGISTRY_IDS)
    for (const pick of PICK_STATES)
      for (const [name, entries] of [
        ['POLY_FILL', POLY_FILL],
        ['POLY_PATTERN', POLY_PATTERN],
        ['POLY_STROKE', POLY_STROKE],
      ] as const) {
        const ids = polygonGlslIds(pick, entries)
        for (const [stage, id] of Object.entries(ids))
          expect(
            baked.has(id),
            `${name} (${stage}) builds '${id}', which BAKED_SHADER_KEYS does not carry — the ` +
              `pipeline that uses this pair would MISS on every lookup`,
          ).toBe(true)
      }
  })

  it('the line stage table pairs each argument with its own stage', () => {
    // The discriminated union already makes a transposed row un-typeable; this pins the
    // VALUES, which the type cannot (both `fs_line` and `fs_line_max` are fragment entries).
    expect(LINE_GLSL_STAGES.vertex).toEqual({ stage: 'vertex', entry: 'vs_line' })
    expect(LINE_GLSL_STAGES.fragment).toEqual({ stage: 'fragment', entry: 'fs_line' })
    expect(LINE_GLSL_STAGES['fragment-pattern']).toEqual({
      stage: 'fragment',
      entry: 'fs_line_pattern',
    })
    expect(LINE_GLSL_STAGES['fragment-max']).toEqual({ stage: 'fragment', entry: 'fs_line_max' })
  })
})

describe('baked ids — ids.ts stays an import-free leaf', () => {
  const IDS_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ids.ts'), 'utf8')

  /** Line-anchored, one pattern per import FORM — a single `[\s\S]*?` spanning regex would
   *  happily match across a prose comment and fail for the wrong reason. */
  const IMPORT_FORMS: ReadonlyArray<{ what: string; re: RegExp; witness: string }> = [
    {
      what: 'an import statement',
      re: /^[ \t]*import[\s{'"*]/m,
      witness: "import { x } from './y'",
    },
    {
      what: 'a single-line re-export',
      re: /^[ \t]*export\b[^\n]*\bfrom\b/m,
      witness: "export * from './y'",
    },
    {
      what: 'a multi-line import/re-export',
      re: /^[ \t]*\}\s*from\s*['"]/m,
      witness: "export {\n  x,\n} from './y'",
    },
    { what: 'a CJS require', re: /\brequire\s*\(/, witness: "const x = require('y')" },
  ]

  it('the detector fires on every import form (not vacuous — #996)', () => {
    for (const { what, re, witness } of IMPORT_FORMS)
      expect(re.test(witness), `the detector for ${what} matches nothing`).toBe(true)
    expect(IMPORT_FORMS[0]?.re.test("import type { X } from './y'")).toBe(true)
    // Prose ABOUT imports is not an import — this file's own header is full of it.
    for (const { re } of IMPORT_FORMS)
      expect(
        re.test('// it cannot agree by importing the registry; exports come from ids.ts\n'),
      ).toBe(false)
  })

  it('ids.ts imports nothing', () => {
    const found = IMPORT_FORMS.filter(({ re }) => re.test(IDS_SRC)).map(({ what }) => what)
    expect(
      found,
      `ids.ts acquired ${found.join(' + ')}. It is the module a RUNTIME consumer reaches for ` +
        `instead of registry.ts (Gate 9 of architecture-invariants.test.ts guards the registry, ` +
        `not this file), so an import here can route the 24 dsl emitters back into the bundle ` +
        `through a door no gate is watching. Keep the grammar a leaf.`,
    ).toEqual([])
  })
})

describe('baked ids — the enumeration is not vacuous (#996)', () => {
  it('the walk really produced the whole closed set', () => {
    expect(PRODUCED.length).toBeGreaterThan(100)
    expect(HILLSHADE_METHOD_FLAGS.length).toBe(5)
    expect(PICK_STATES.length).toBe(2)
    expect(BAKED_STAGES.length).toBe(2)
    expect(SIMPLE_FAMILIES.length).toBeGreaterThanOrEqual(14)
    expect(PICKED_MODULE_FAMILIES.length).toBe(2)
    expect(LINE_GLSL_STAGE_ARGS.length).toBe(4)
    expect(new Set(BAKED_SHADER_KEYS.map((k) => k.family)).size).toBeGreaterThanOrEqual(19)
  })

  it('the set comparison DISTINGUISHES a dropped id (cut the mechanism)', () => {
    // Both directions of (a) run through `missingFrom`. If it answered `[]` for everything
    // — an empty input, a broken `Set`, a swapped argument — both arms would pass over a
    // hole. Sever one id and confirm the diff names exactly it.
    const severed = PRODUCED_IDS.filter((id) => id !== 'glsl/polygon/pick/fragment/fs_stroke')
    expect(missingFrom(REGISTRY_IDS, severed)).toEqual(['glsl/polygon/pick/fragment/fs_stroke'])
    // …and the other direction, on synthetic inputs so this self-test stays readable when
    // the real sets are the thing that broke.
    expect(missingFrom(['a', 'b'], ['a'])).toEqual(['b'])
    expect(missingFrom(['a'], ['a', 'b'])).toEqual([])
  })
})
