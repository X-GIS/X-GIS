// ═══ The store is filled BEFORE the first frame — two arms, two different claims (#1679) ═══
//
// `bootGpuContext` hands the caller a device; the caller's next act is to build drapers and
// draw. Every draper that runs before `install.ts` has merged the boot artifact emits its
// shader at runtime — the pixels are right (the fall-through is the same thunk) and the
// entire point of the bake is silently lost, which is precisely the failure class no render
// gate and no unit test notices on its own. Hence two arms, and they catch DIFFERENT things:
//
//   STRUCTURAL (reads gpu-boot.ts's source) — nothing may sit BETWEEN the install and the
//     return. The behavioural arm cannot see this: insert an `await someFrameKick()` after
//     the install and the store is still filled by the time `ctx` is handed back, so a
//     lookup still hits and the behavioural arm stays green — while the real boot has just
//     grown a step that runs against a store whose content is now an accident of ordering.
//
//   BEHAVIOURAL (runs a fake boot, then looks an id up) — the install must actually FILL
//     the store, for the device's own language, with ids the grammar spells. The structural
//     arm cannot see any of that: the line is still there when the import resolves to an
//     empty module, when `mergeBakedSources` is never reached, when the WGSL half is
//     installed for a GLSL device, or when a grammar change moves the ids out from under
//     the lookup. Source text is not behaviour.
//
// Deleting `await installBakedShaders(ctx.rhi)` reddens BOTH — that cut is the shared
// premise, not the reason there are two. The reason is the two cuts above, each of which
// reddens exactly one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EARTH, configureBody } from '@xgis/shared'
import { configureBodyConsts } from '../../body-consts'
import { _resetBakedBodyGuardMemo } from './body-guard'
import { simpleGlslId } from './ids'
import { bakedSource, bakedStoreStats, _resetBakedStore } from './store'

// The chain is stubbed at the package boundary rather than at `bootGpuContext`'s: the
// function under test must be the REAL one, or the arm proves nothing about the boot. The
// factory declares only the two symbols gpu-boot.ts imports as values — no `importOriginal`,
// so a headless test never touches the WebGPU adapter code.
const FAKE_RHI = { caps: { shaderLanguage: 'glsl-es300' } }
vi.mock('@xgis/rhi-webgpu', () => ({
  initGPUViaProviders: () => Promise.resolve({ rhi: FAKE_RHI }),
  backendProviderChain: () => [],
}))

const GPU_BOOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gpu-boot.ts')
const SRC = readFileSync(GPU_BOOT, 'utf8')

/** The meaningful (non-blank, non-comment) lines of `bootGpuContext`'s body, trimmed —
 *  extracted as a function so the self-test below can run it over synthetic sources and
 *  prove it DISTINGUISHES the orderings it is meant to judge. */
function bootTail(source: string): string[] {
  const start = source.indexOf('export async function bootGpuContext')
  if (start < 0) return []
  const end = source.indexOf('\n}\n', start)
  if (end < 0) return []
  return source
    .slice(start, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'))
}

describe('baked shaders — STRUCTURAL: the install is the last thing a boot does (#1679)', () => {
  it('gpu-boot.ts imports installBakedShaders from the install module', () => {
    // Anchored on the SPECIFIER, not the identifier: a local `const installBakedShaders =
    // () => {}` would satisfy a name-only check and install nothing.
    expect(
      /import\s*\{\s*installBakedShaders\s*\}\s*from\s*'\.\/shaders\/baked\/install'/.test(SRC),
      'bootGpuContext must call the real install seam, not a same-named local',
    ).toBe(true)
  })

  it('nothing sits between the install await and the returned context', () => {
    const tail = bootTail(SRC)
    expect(tail.length, 'bootGpuContext was not found / not parsed').toBeGreaterThan(3)
    expect(
      tail.slice(-2),
      `the last two statements of bootGpuContext are ${JSON.stringify(tail.slice(-2))}. ` +
        `The baked store must be filled with NOTHING between it and the caller: the caller ` +
        `builds drapers immediately, and a step slipped in here runs against a store whose ` +
        `content is an accident of ordering. Keep the install await — the Promise.all that ` +
        `runs it CONCURRENTLY with the hillshade seed — immediately before 'return ctx'.`,
    ).toEqual([
      'await Promise.all([seedBakedShaders(ctx.rhi), installBakedShaders(ctx.rhi)])',
      'return ctx',
    ])
  })

  it('the extractor DISTINGUISHES a statement slipped in (cut the mechanism, #996)', () => {
    // Without this the arm above passes identically whether `bootTail` reads the function
    // or returns a fossilised list — and the whole claim rests on the last two entries.
    const ok = [
      'export async function bootGpuContext(deps: GpuBootDeps): Promise<GPUContext> {',
      '  const ctx = await init()',
      '  // a comment is not a statement',
      '',
      '  await Promise.all([seedBakedShaders(ctx.rhi), installBakedShaders(ctx.rhi)])',
      '  return ctx',
      '}',
      '',
    ].join('\n')
    expect(bootTail(ok).slice(-2)).toEqual([
      'await Promise.all([seedBakedShaders(ctx.rhi), installBakedShaders(ctx.rhi)])',
      'return ctx',
    ])
    const slipped = ok.replace('  return ctx', '  await warmUpSomething()\n  return ctx')
    expect(
      bootTail(slipped).slice(-2),
      'a statement inserted between the install and the return must be VISIBLE here',
    ).not.toEqual([
      'await Promise.all([seedBakedShaders(ctx.rhi), installBakedShaders(ctx.rhi)])',
      'return ctx',
    ])
    expect(bootTail('nothing to see'), 'a missing function must not read as a pass').toEqual([])
  })
})

describe('baked shaders — BEHAVIOURAL: after a boot, a boot-group lookup HITS (#1679)', () => {
  const BOOT_ID = simpleGlslId('icon', 'vertex')

  beforeEach(() => {
    _resetBakedStore()
    _resetBakedBodyGuardMemo()
    configureBody(EARTH)
    configureBodyConsts(EARTH)
  })

  afterEach(() => {
    _resetBakedStore()
    _resetBakedBodyGuardMemo()
  })

  it('bootGpuContext leaves the store able to serve the device‘s own language', async () => {
    expect(bakedSource(BOOT_ID), 'pre-boot: nothing is installed').toBeUndefined()
    _resetBakedStore()

    const { bootGpuContext } = await import('../../gpu-boot')
    const ctx = await bootGpuContext({
      canvas: {} as HTMLCanvasElement,
      backend: 'auto',
      preserveDrawingBuffer: false,
      makeWebGl2Device: (() => null) as never,
      adoptCanvas: () => {},
    })
    expect(ctx.rhi, 'the fake chain must be what booted').toBe(FAKE_RHI)

    const served = bakedSource(BOOT_ID)
    expect(
      served,
      `${BOOT_ID} must be served from the bake the moment the boot returns — a draper built ` +
        `on the caller's next line would otherwise pay the runtime emit the bake exists to ` +
        `replace`,
    ).toBeTypeOf('string')
    expect(served, 'a served source is real shader text, not an empty string').toContain('main')
    expect(bakedStoreStats()).toMatchObject({ hits: 1, misses: 0, closed: 0, absent: 0 })
    // …and the store carries the whole boot group, not just the one id asked for.
    expect(bakedStoreStats().ids).toBeGreaterThan(1)
  })
})
