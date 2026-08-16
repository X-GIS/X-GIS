// ═══ `?adaptive=0` actually disables the resolution ladder (#1733) ═══
//
// `resolveQuality()`'s URL parsing had NO test. That was survivable while the flags were
// only a developer convenience; it stopped being survivable when a render gate started
// depending on one of them.
//
// #1733: `_gl2-live-swap-gate` compares a frame from before a live re-boot with one from
// after. Under batch load the adaptive controller steps down to its `{ farLod: 4, dpr:
// 0.85 }` notch (`adaptive-quality.ts:91`) between the two captures, so the gate silently
// compared 731x612 against 860x720 — an edge-only diff of 43089 px that read as a re-boot
// defect and cost three wrong diagnoses. The gate now boots with `?adaptive=0`.
//
// So this asserts the seam that fix rests on: the flag is parsed, AND the parsed value
// reaches the controller. The second half is the one that would rot silently — `QUALITY`
// could keep reporting `adaptive: false` while `setAdaptiveQualityEnabled` stopped being
// called at module load (`quality.ts:265`), and every consumer of the flag would be
// quietly back to an unpinned ladder.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/** Re-import `quality.ts` under a stubbed URL. `QUALITY` is a module-load constant and the
 *  controller is configured at load, so the flag can only be exercised by re-evaluating
 *  the module — importing it once and mutating afterwards would test `setQuality()`, which
 *  is a different seam. */
async function bootWith(search: string) {
  vi.resetModules()
  vi.stubGlobal('window', { location: { href: `https://x-gis.test/demo.html${search}` } })
  const quality = await import('./quality')
  const adaptive = await import('./adaptive-quality')
  return { QUALITY: quality.QUALITY, isEnabled: adaptive.isAdaptiveQualityEnabled }
}

describe('?adaptive=0 — the flag a render gate depends on (#1733)', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('is ON by default — the controller costs nothing on a host that keeps up', async () => {
    // Non-vacuity for every arm below: if the default were already off, "the flag turned
    // it off" would be indistinguishable from the flag doing nothing at all.
    const { QUALITY, isEnabled } = await bootWith('')
    expect(QUALITY.adaptive).toBe(true)
    expect(isEnabled()).toBe(true)
  })

  it('parses, and the parsed value REACHES the controller', async () => {
    const { QUALITY, isEnabled } = await bootWith('?adaptive=0')
    expect(QUALITY.adaptive).toBe(false)
    // The half that matters: `quality.ts:265` applies the policy at module load. Without
    // this arm, deleting that line leaves QUALITY.adaptive === false and the ladder still
    // running — exactly the confound #1733 spent three rounds diagnosing.
    expect(isEnabled()).toBe(false)
  })

  it('accepts the spellings the other flags accept', async () => {
    for (const s of ['?adaptive=0', '?adaptive=false', '?adaptive=off']) {
      const { QUALITY, isEnabled } = await bootWith(s)
      expect(QUALITY.adaptive, s).toBe(false)
      expect(isEnabled(), s).toBe(false)
    }
  })

  it('only an explicit disable is honoured — an unrelated value leaves it on', async () => {
    // `?adaptive=1` and a typo must not silently disable the controller: a flag that turns
    // off on anything it does not recognise is worse than one that ignores you.
    for (const s of ['?adaptive=1', '?adaptive=yes', '?adaptivex=0']) {
      const { QUALITY, isEnabled } = await bootWith(s)
      expect(QUALITY.adaptive, s).toBe(true)
      expect(isEnabled(), s).toBe(true)
    }
  })
})
