// ═══ The boot-group simple families READ the bake — call site → id → bytes (#1679 inc 5) ═══
//
// Increments 1-4 built the whole mechanism and wired none of it: `install.ts` filled the
// store at device attach, `wgsl-for.ts` grew an optional trailing id, and every call site
// still passed `undefined`. So the bake was downloaded on every boot and read by nobody —
// a state no gate could see, because the pixels are identical either way (the fall-through
// is the same thunk). Increment 5 passes the ids for the seven PARAMETERLESS boot-group
// families, and this file is what stops that rewiring from being silently undone.
//
// THE CHAIN, and why each link needs its own arm:
//
//   A. the call site passes an id at all       — a reverted call site emits at runtime
//                                                forever, with no other symptom
//   B. the id is DERIVED, not spelled          — a literal 'glsl/icon/vertex' survives a
//                                                grammar change that moves the real key,
//                                                and then every lookup silently misses
//   C. the derived id EXISTS in the committed  — the grammar and the artifact are two
//      boot artifact                             authorities; baked-sync ties artifact↔
//                                                registry, nothing tied call-site↔artifact
//   D. the rewired SET is exactly the eligible — the failure this cannot otherwise see is
//      set                                       an eighth family arriving un-rewired, or
//                                                a deferred one being rewired early
//
// Link D is a SET EQUALITY against a derived expectation, not a for-each over a hand list:
// a loop over the seven files can only ever confirm the seven files (§996 — an assertion
// that cannot fail for the case it exists to catch). The eligible set is computed from
// `SIMPLE_FAMILIES` ∩ boot group, minus a shrink-only DEFERRED allowlist whose entries
// carry a reason and an increment number.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: construct the drapers. Each one builds a real
// `Material`, which needs a device that creates shader modules, pipelines and bind-group
// layouts — a mock deep enough to do that is a second implementation of the RHI, and its
// drift would be the bug rather than the check. The behaviour of the seam itself (serve,
// fall through, never mix, both-or-neither) is already pinned against a real store in
// `wgsl-for-baked.test.ts`; what was missing, and what this file adds, is the chain from
// the CALL SITE to the bytes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FAMILY_GROUPS,
  SIMPLE_FAMILIES,
  simpleGlslId,
  simpleWgslId,
  type SimpleFamily,
} from '../../shaders/baked/ids'

const HERE = dirname(fileURLToPath(import.meta.url))
const BAKED = join(HERE, '..', '..', 'shaders', 'baked')

/** family → the material file that constructs its draper. The VALUE is what makes link A
 *  checkable; the KEY set is what link D compares against. */
const REWIRED: Readonly<Record<string, string>> = {
  icon: 'icon-material.ts',
  point: 'point-material.ts',
  text: 'text-material.ts',
  'circle-retained': 'circle-retained-material.ts',
  'icon-retained': 'icon-retained-material.ts',
  'arrow-retained': 'arrow-retained-material.ts',
  'particle-retained': 'particle-retained-material.ts',
  'arrow-retained-advected': 'arrow-retained-advected-material.ts',
}

/** Boot-group simple families NOT rewired yet, each with the reason and the increment that
 *  closes it. SHRINK-ONLY: when one is rewired, its entry must be deleted in the same
 *  commit or the arm below reds — an allowlist that outlives its reason is how a deferral
 *  becomes permanent by accident. */
const DEFERRED: Readonly<Record<string, string>> = {
  // EMPTY since #1679 increment 6 rewired `point` (behind a null-variant guard — see
  // entry-and-variant-rewiring.test.ts G1). The loop below is therefore vacuous today, and
  // deliberately kept: it costs nothing and reds the day a new deferral is added and then
  // quietly closed. The claim that nothing is UNACCOUNTED for is carried by link D's set
  // equality, which does not weaken when this object is empty.
}

const sourceOf = (file: string): string => readFileSync(join(HERE, file), 'utf8')

/** The id index of a committed artifact, read as TEXT rather than imported: the generated
 *  modules are large and this only needs the key set. */
function artifactIds(file: string): ReadonlySet<string> {
  const src = readFileSync(join(BAKED, file), 'utf8')
  const block = /index:\s*\{(.*?)\n\s{2}\}/s.exec(src)
  if (block === null) return new Set()
  return new Set([...block[1].matchAll(/'([^']+)':/g)].map((m) => m[1]))
}

const GLSL_BOOT = artifactIds('baked-glsl-boot.generated.ts')
const WGSL_BOOT = artifactIds('baked-wgsl-boot.generated.ts')

describe('#1679 inc 5 — reader sanity (the arms below are vacuous without this)', () => {
  it('every rewired material file was read and is non-trivial', () => {
    for (const [family, file] of Object.entries(REWIRED)) {
      const src = sourceOf(file)
      expect(
        src.length,
        `${file} (for '${family}') read as ${src.length} bytes — the path is wrong or the ` +
          `file moved, and every link-A assertion below would then pass over an empty string`,
      ).toBeGreaterThan(500)
    }
  })

  it('both committed boot artifacts yielded an id index', () => {
    // A regex that stops matching returns an EMPTY set, and link C is a membership test —
    // so every id would read as missing, not as present. This arm is the one that says
    // which half broke.
    expect(
      GLSL_BOOT.size,
      'no ids parsed out of baked-glsl-boot.generated.ts — the `index:` reader is broken, ' +
        'not the artifact (42 ids today)',
    ).toBeGreaterThanOrEqual(20)
    expect(
      WGSL_BOOT.size,
      'no ids parsed out of baked-wgsl-boot.generated.ts — the `index:` reader is broken ' +
        '(16 ids today)',
    ).toBeGreaterThanOrEqual(10)
  })
})

describe('#1679 inc 5 — A+B: every rewired call site passes a DERIVED id', () => {
  for (const [family, file] of Object.entries(REWIRED)) {
    it(`${family} passes simpleWgslId + both simpleGlslId stages`, () => {
      const src = sourceOf(file)
      // Anchored on the BUILDER CALL, not on the id string. A call site that spelled
      // 'wgsl/icon' as a literal would satisfy a value check and then silently miss the
      // day the grammar moves — which is exactly what ids.ts exists to prevent.
      expect(
        src,
        `${file} does not call simpleWgslId('${family}') — its WGSL shader is emitted at ` +
          `runtime on every boot while the bake that contains it sits unread in the store`,
      ).toContain(`simpleWgslId('${family}')`)
      for (const stage of ['vertex', 'fragment'] as const)
        expect(
          src,
          `${file} does not call simpleGlslId('${family}', '${stage}') — glslStagesFor is ` +
            `BOTH-OR-NEITHER, so a missing stage id makes the OTHER stage's hit worthless ` +
            `too: the thunk runs and supplies both halves`,
        ).toContain(`simpleGlslId('${family}', '${stage}')`)
    })
  }
})

describe('#1679 inc 5 — C: every derived id exists in the committed boot artifact', () => {
  for (const family of Object.keys(REWIRED)) {
    it(`${family}'s three ids resolve`, () => {
      const f = family as SimpleFamily
      expect(
        WGSL_BOOT.has(simpleWgslId(f)),
        `${simpleWgslId(f)} is not in baked-wgsl-boot.generated.ts. The call site asks for ` +
          `it on every WebGPU boot and the store answers 'absent', so the bake is downloaded ` +
          `and then ignored for this family. Either the grammar moved without the artifact ` +
          `being regenerated (bun run bake:shaders), or the family's group changed.`,
      ).toBe(true)
      for (const stage of ['vertex', 'fragment'] as const)
        expect(
          GLSL_BOOT.has(simpleGlslId(f, stage)),
          `${simpleGlslId(f, stage)} is not in baked-glsl-boot.generated.ts — same cause, ` +
            `and on WebGL2 it costs BOTH stages, not one (both-or-neither).`,
        ).toBe(true)
    })
  }
})

describe('#1679 inc 5 — D: the rewired set is exactly the eligible set', () => {
  it('rewired ∪ deferred === the boot-group simple families', () => {
    const eligible = SIMPLE_FAMILIES.filter((f) => FAMILY_GROUPS[f] === 'boot')
    const covered = new Set([...Object.keys(REWIRED), ...Object.keys(DEFERRED)])
    // SET EQUALITY in both directions. A for-each over REWIRED can only confirm what is
    // already in REWIRED; the failure worth catching is an EIGHTH boot-group simple family
    // arriving and nobody wiring it, which only a comparison against the derived set sees.
    expect(
      [...covered].sort(),
      `the boot-group simple families and the families this file accounts for have diverged. ` +
        `Eligible (SIMPLE_FAMILIES ∩ boot group): ${eligible.join(', ')}. Accounted for ` +
        `(REWIRED + DEFERRED): ${[...covered].sort().join(', ')}. A new family on the left ` +
        `needs either a REWIRED row (pass its ids at the call site) or a DEFERRED row with ` +
        `the reason; one on the right that is no longer boot-group or no longer simple has ` +
        `moved and its row must move with it.`,
    ).toEqual([...eligible].sort())
  })

  it('no DEFERRED family has quietly been rewired (shrink-only)', () => {
    for (const [family, reason] of Object.entries(DEFERRED)) {
      expect(reason, `DEFERRED['${family}'] must cite the increment that closes it`).toMatch(/#\d+/)
      const file = `${family}-material.ts`
      let src = ''
      try {
        src = sourceOf(file)
      } catch {
        continue // a deferred family whose file is named differently — link D still covers it
      }
      expect(
        src.includes(`simpleWgslId('${family}')`),
        `${file} now calls simpleWgslId('${family}'), so '${family}' is no longer deferred — ` +
          `move it from DEFERRED to REWIRED in this same commit. An allowlist entry that ` +
          `outlives its reason is how a deferral becomes permanent by accident.`,
      ).toBe(false)
    }
  })

  it('every REWIRED family is genuinely simple and genuinely boot-group', () => {
    for (const family of Object.keys(REWIRED)) {
      expect(
        (SIMPLE_FAMILIES as readonly string[]).includes(family),
        `'${family}' is in REWIRED but not in SIMPLE_FAMILIES — simpleWgslId/simpleGlslId ` +
          `spell a parameterless key, so a family that grew an axis cannot use them`,
      ).toBe(true)
      expect(
        FAMILY_GROUPS[family as SimpleFamily],
        `'${family}' is in REWIRED but its download group is not 'boot'. Only the boot group ` +
          `is installed at device attach (install.ts); a lazy family's ids would resolve to ` +
          `'absent' at every call and the rewiring would be a slower no-op.`,
      ).toBe('boot')
    }
  })
})
