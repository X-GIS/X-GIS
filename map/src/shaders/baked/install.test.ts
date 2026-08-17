// ═══ Installing the boot-group artifact into the store (#1679 increment 4) ═══
//
// `install.ts` is the second boot seam: it downloads ONE artifact — the boot group of the
// device's own language — and merges it into `store.ts`, which is what the keyed emit seam
// reads. What has to be true of it is not "the store ends up holding bytes" (that is
// `store.test.ts`'s subject) but the three properties the boot path adds:
//
//   (a) THE SPLIT IS REAL — a boot installs the boot group and NOT the lazy one, and not
//       the other language's. A store that quietly carried everything would pass every
//       downstream gate while the bundle grew back to the pre-split size, which is the one
//       thing the split exists to prevent. Each arm therefore asserts a NEGATIVE beside its
//       positive: a lazy id must read ABSENT after a successful install.
//   (b) THE BODY GUARD CLOSES IT — the artifact embeds Earth's radii as literals, so on
//       another planet nothing may be served. The interesting half is WHICH outcome: the
//       store must count `closed`, never `miss`, or a Moon page reports a page-full of
//       bugs; and it must RE-OPEN when the body returns, because the guard is asked per
//       lookup rather than snapshotted at install.
//   (c) A FAILED CHUNK IS NOT A DEAD MAP — `bootGpuContext` awaits this call, so a reject
//       here takes the whole boot down. Both failure shapes are driven (the import
//       rejecting, and the import resolving without the export).
//
// Plus the GROUP CENSUS at the bottom, which is a different kind of claim entirely: it
// reads `graphics-manager.ts` and asserts that what it constructs at attach really is in
// the boot group. Nothing else can catch a family filed under the wrong group — see that
// describe's own header.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EARTH, MOON, configureBody, type Body } from '@xgis/shared'
import { configureBodyConsts } from '../../body-consts'
import type { ShaderSourceDevice } from '../../render/material/wgsl-for'
import { _resetBakedBodyGuardMemo } from './body-guard'
import { FAMILY_GROUPS, simpleGlslId, simpleWgslId, type BakedFamily } from './ids'
import { bakedSource, bakedStoreStats, _resetBakedStore } from './store'
import { installBakedShaders, _resetBakedInstallWarning } from './install'

const GLSL_DEVICE: ShaderSourceDevice = { caps: { shaderLanguage: 'glsl-es300' } }
const WGSL_DEVICE: ShaderSourceDevice = { caps: { shaderLanguage: 'wgsl' } }

// Ids built through the grammar, never typed as literals: a token change must move this
// spec's inputs with it. `icon` is a boot family, `heatmap-blur` a lazy one.
const BOOT_GLSL = simpleGlslId('icon', 'vertex')
const LAZY_GLSL = simpleGlslId('heatmap-blur', 'vertex')
const BOOT_WGSL = simpleWgslId('icon')

const switchBody = (body: Body): void => {
  configureBody(body)
  configureBodyConsts(body)
}

beforeEach(() => {
  _resetBakedStore()
  _resetBakedBodyGuardMemo()
  _resetBakedInstallWarning()
})

afterEach(() => {
  switchBody(EARTH)
  _resetBakedBodyGuardMemo()
  _resetBakedStore()
  vi.unstubAllGlobals()
})

describe('baked shaders — installBakedShaders serves the BOOT group only (#1679)', () => {
  it('a boot-group id HITS and a lazy-group id reads ABSENT', async () => {
    const n = await installBakedShaders(GLSL_DEVICE)
    expect(n, 'the boot artifact must carry ids').toBeGreaterThan(0)
    expect(bakedSource(BOOT_GLSL), `${BOOT_GLSL} is in the boot group`).toBeTypeOf('string')
    expect(
      bakedSource(LAZY_GLSL),
      `${LAZY_GLSL} is in the LAZY group — installing it at boot would put the two files ` +
        `back together and hand every map bytes it will probably never read`,
    ).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ hits: 1, absent: 1, misses: 0, closed: 0 })
  })

  it('a WGSL device installs the WGSL half — and the GLSL ids are not in it', async () => {
    await installBakedShaders(WGSL_DEVICE)
    expect(bakedSource(BOOT_WGSL)).toBeTypeOf('string')
    // `rhi-webgpu`'s createPipeline reads `desc.code` and ignores vsCode/fsCode entirely,
    // so a WGSL boot that also carried the GLSL would be downloading bytes no pipeline on
    // it can read. Absent, not miss: the GLSL half was never installed.
    expect(bakedSource(BOOT_GLSL)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ hits: 1, absent: 1, misses: 0 })
  })

  it('?nobake=1 turns the seam off — nothing is installed and nothing is served', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost/demo.html?nobake=1' } })
    expect(await installBakedShaders(GLSL_DEVICE)).toBe(0)
    expect(bakedSource(BOOT_GLSL)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ ids: 0, coverage: 0, absent: 1, hits: 0 })
  })
})

describe('baked shaders — the body guard CLOSES the install, and re-opens it (#1679)', () => {
  it('MOON: the install lands but every lookup is CLOSED, never a miss', async () => {
    switchBody(MOON)
    // The install itself does NOT consult the guard — deliberately. The guard is per
    // lookup, which is what makes the re-open below possible; snapshotting it here would
    // close the bake for the rest of the page's life the moment a boot happened on the
    // wrong planet.
    expect(await installBakedShaders(GLSL_DEVICE)).toBeGreaterThan(0)
    expect(
      bakedSource(BOOT_GLSL),
      'the artifact embeds Earth radii as literals; on the Moon its bytes are wrong',
    ).toBeUndefined()
    expect(
      bakedStoreStats(),
      'a wrong-planet lookup is EXPECTED (closed), not the #996 bug (miss)',
    ).toMatchObject({ hits: 0, closed: 1, misses: 0, absent: 0 })
  })

  it('EARTH returns and the same store serves again — no re-install, no memo reset', async () => {
    await installBakedShaders(GLSL_DEVICE)
    expect(bakedSource(BOOT_GLSL)).toBeTypeOf('string')

    switchBody(MOON)
    expect(bakedSource(BOOT_GLSL)).toBeUndefined()

    // No `_resetBakedBodyGuardMemo()` here on purpose: the guard must re-derive off the
    // body epoch on its own, or a returning body would find the bake permanently shut.
    switchBody(EARTH)
    expect(bakedSource(BOOT_GLSL), 'the body returned; so must the bake').toBeTypeOf('string')
    expect(bakedStoreStats()).toMatchObject({ hits: 2, closed: 1, misses: 0 })
  })
})

describe('baked shaders — a chunk that will not load costs a frame, not the boot (#1679)', () => {
  const BROKEN: ReadonlyArray<{ how: string; factory: () => Promise<object> | object }> = [
    { how: 'the chunk fails to load', factory: () => Promise.reject(new Error('simulated 404')) },
    { how: 'the chunk loads without the export', factory: () => ({}) },
  ]
  for (const { how, factory } of BROKEN)
    it(`resolves 0 with an EMPTY store when ${how}`, async () => {
      // `vi.doMock` + a fresh import of the module under test, so the real artifact path
      // every arm above drives stays untouched (the seed-hillshade spec's precedent).
      vi.resetModules()
      vi.doMock('./baked-glsl-boot.generated', factory)
      try {
        const fresh = await import('./install')
        const store = await import('./store')
        store._resetBakedStore()
        await expect(fresh.installBakedShaders(GLSL_DEVICE)).resolves.toBe(0)
        expect(
          store.bakedStoreStats(),
          'a failed install must leave NOTHING installed — a half-filled store would read ' +
            'as a miss (a bug) on every id the chunk would have carried',
        ).toMatchObject({ ids: 0, coverage: 0 })
        expect(store.bakedSource(BOOT_GLSL)).toBeUndefined()
      } finally {
        vi.doUnmock('./baked-glsl-boot.generated')
        vi.resetModules()
      }
    })
})

// ═══ The GROUP CENSUS — is a family in the group its call sites justify? ═══
//
// `FAMILY_GROUPS` is a judgement about WHAT A BOOT REACHES, and a judgement is exactly the
// thing that rots. Every other gate is blind to it: `baked-sync.test.ts` compares the
// artifacts to the table (so it goes red only until someone re-bakes, after which a wrong
// group is permanently green), and any behavioural arm that derives its expectations from
// the table is vacuous by construction — moving a family moves the expectation with it.
//
// So the census reads an INDEPENDENT authority: `GraphicsManager.attachDevice`, which
// constructs five retained drapers UNCONDITIONALLY the moment a device exists, each of
// whose constructors emits its shader immediately. Those five families are reached by
// every boot as a matter of fact, not of style, and they are exactly the ones a reader is
// most likely to file as "exotic, surely lazy".
//
// LIMIT, stated rather than implied: this covers the five eager drapers. `polygon`, `line`,
// `point`, `icon`, `text`, `raster` and `under-occluder` are boot-group by an argument
// about styles (see the rows in `ids.ts`), and no mechanical authority in the repo can
// confirm that — a wrong group there is caught only by the re-bake drift and by review.
describe('baked shaders — the boot group matches the eager-construction census (#1679)', () => {
  const MANAGER = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'graphics',
    'graphics-manager.ts',
  )

  /** The body of `attachDevice`, from its signature to the first line that closes at its
   *  own indentation. Deliberately not a full parse: the assertion below fails loudly if
   *  the extraction stops finding drapers, so a shape change cannot leave it vacuous. */
  function attachDeviceBody(): string {
    const src = readFileSync(MANAGER, 'utf8')
    const start = src.indexOf('  attachDevice(')
    expect(
      start,
      'GraphicsManager.attachDevice not found — the census lost its source',
    ).toBeGreaterThan(0)
    const end = src.indexOf('\n  }\n', start)
    expect(end, 'attachDevice has no closing brace at method indentation').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  /** Draper class → the baked family its Material emits. The one hand-maintained link,
   *  and it is checked in both directions: an unmapped `new …Draper(` in the body fails,
   *  so a SIXTH eager draper cannot be added without classifying its family here. */
  const DRAPER_FAMILY: Readonly<Record<string, BakedFamily>> = {
    RetainedIconDraper: 'icon-retained',
    RetainedArrowDraper: 'arrow-retained',
    RetainedArrowAdvectedDraper: 'arrow-retained-advected',
    RetainedCircleDraper: 'circle-retained',
    RetainedParticleDraper: 'particle-retained',
  }

  const constructed = (): string[] => [
    ...new Set(
      [...attachDeviceBody().matchAll(/new\s+(\w*Draper)\s*\(/g)].map((m) => m[1] as string),
    ),
  ]

  it('the census still finds the eagerly-constructed drapers (#996: not vacuous)', () => {
    expect(
      constructed().sort(),
      'attachDevice no longer constructs the drapers this census reads — re-derive the boot ' +
        'group from whatever replaced them before trusting FAMILY_GROUPS again',
    ).toEqual(Object.keys(DRAPER_FAMILY).sort())
  })

  it('every family attachDevice reaches at boot is in the BOOT group', () => {
    const misfiled: string[] = []
    for (const cls of constructed()) {
      const family = DRAPER_FAMILY[cls]
      if (family === undefined || FAMILY_GROUPS[family] === 'boot') continue
      misfiled.push(
        `${family} is filed as '${FAMILY_GROUPS[family]}', but GraphicsManager.attachDevice ` +
          `constructs ${cls} unconditionally at EVERY boot (its constructor emits the shader ` +
          `immediately) — the artifact holding it must be the one the boot downloads`,
      )
    }
    expect(misfiled, misfiled.join('\n')).toEqual([])
  })

  // The census above is mechanical but PARTIAL — it can only speak for the five drapers
  // `attachDevice` constructs. Measured while landing increment 4: move `polygon` to 'lazy'
  // and re-bake, and every other gate in the repo goes green (the artifacts follow the
  // table, and any behavioural arm derives its expectations from it), so the map quietly
  // stops downloading its own fill shader. This pin is what closes that hole. It is
  // deliberately a SECOND COPY of the table, and its only job is to make a group change a
  // REVIEWED diff rather than a silent one — the same construction as `earth-literal-
  // ratchet`'s ALLOWLIST, which duplicates nothing more than the decision it guards.
  it('the group of every family is the one the census justified (a change must be reviewed)', () => {
    expect(
      FAMILY_GROUPS,
      'a family changed download group. That is a claim about WHAT A BOOT REACHES, and no ' +
        'other gate can check it: re-bake and the artifacts simply follow. Re-derive the ' +
        'census from the call sites (the rows in ids.ts say where each was read off), and if ' +
        'the new group is right, update this pin in the same commit with the evidence.',
    ).toEqual({
      hillshade: 'hillshade',
      polygon: 'boot',
      line: 'boot',
      point: 'boot',
      icon: 'boot',
      text: 'boot',
      raster: 'boot',
      'circle-retained': 'boot',
      'icon-retained': 'boot',
      'arrow-retained': 'boot',
      'particle-retained': 'boot',
      'arrow-retained-advected': 'boot',
      'under-occluder': 'boot',
      'heatmap-accum': 'lazy',
      'heatmap-blur': 'lazy',
      'heatmap-compose': 'lazy',
      'flow-advect': 'lazy',
      'scene-upscale': 'lazy',
      'line-composite': 'lazy',
    })
  })

  it('every closed-set family has exactly one group, and every group is populated', () => {
    // The `Record<BakedFamily, BakedGroup>` type already forces a row per family; this
    // pins the other direction — an EMPTY group would mean a committed artifact with no
    // keys, which `baked-sync.test.ts`'s non-empty arm turns into a confusing failure two
    // files away from the cause.
    const populated = new Set(Object.values(FAMILY_GROUPS))
    expect([...populated].sort()).toEqual(['boot', 'hillshade', 'lazy'])
    expect(FAMILY_GROUPS.hillshade, 'hillshade keeps its own file (phase A seeds it)').toBe(
      'hillshade',
    )
  })
})
