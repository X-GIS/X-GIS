// #1364 — failing the run must not be silent about WHICH source failed.
//
// THE DEFECT THIS PINS: a non-reprojection source failure (HTTP, JSON parse,
// SSRF refusal) re-throws and aborts run(). That contract is deliberate and is
// NOT changed here. What was wrong is that it was opaque: run() rejected, the
// canvas was never sized, `loaded()` never went true, and the host got no typed
// signal naming the culprit — the only evidence was a console line. An
// embedding app could not report "layer X is down" because it never learned X.
//
// This logic used to be inline in XGISMap.run(), where reaching it required a
// live GPU context; the extraction is what makes it assertable at all.

import { describe, expect, it } from 'vitest'
import { settleSourceLoads } from './source-load-outcome'
import type { XGISMapErrorInfo } from './layer'

const ok = (): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value: undefined })
const bad = (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason })

function run(
  results: PromiseSettledResult<unknown>[],
  loads: { name: string }[],
): { threw: unknown; fired: XGISMapErrorInfo[] } {
  const fired: XGISMapErrorInfo[] = []
  let threw: unknown = null
  try {
    settleSourceLoads(results, loads, (i) => fired.push(i))
  } catch (e) {
    threw = e
  }
  return { threw, fired }
}

describe('settleSourceLoads (#1364)', () => {
  it('names the failing source before re-throwing', () => {
    const boom = new Error('503 from tiles.example.com')
    const { threw, fired } = run(
      [ok(), bad(boom), ok()],
      [{ name: 'land' }, { name: 'rivers' }, { name: 'lakes' }],
    )

    // The contract is unchanged — it still aborts the run.
    expect(threw, 'a non-reprojection failure still fails the run').toBe(boom)
    // …but it is no longer anonymous.
    expect(fired.length).toBe(1)
    expect(fired[0].phase).toBe('source')
    expect(fired[0].source, 'the host must learn WHICH source killed the boot').toBe('rivers')
    expect(fired[0].fatal, 'the run dies, so this is fatal').toBe(true)
    expect(fired[0].error).toBe(boom)
  })

  it('picks the name by INDEX, not by position among the failures', () => {
    // `loads` is index-parallel with `results`. Reading the name from a filtered
    // list of failures instead would attribute the error to the wrong layer —
    // silently, and only when an earlier source succeeded.
    const boom = new Error('bad')
    const { fired } = run(
      [ok(), ok(), bad(boom)],
      [{ name: 'first' }, { name: 'second' }, { name: 'third' }],
    )
    expect(fired[0].source).toBe('third')
  })

  it('isolates an EPSG-reprojection failure: no throw, no event', () => {
    // The AC7 carve-out. It is logged and the other loads stand, so raising a
    // fatal event here would misreport a survivable condition.
    const reproj = Object.assign(new Error('unsupported crs'), { xgisReprojectFailure: true })
    const { threw, fired } = run([bad(reproj), ok()], [{ name: 'weird' }, { name: 'land' }])

    expect(threw, 'a bad-CRS source must not abort the run').toBeNull()
    expect(fired, 'and must not be reported as a fatal source error').toEqual([])
  })

  it('throws the FIRST non-isolated failure when several fail', () => {
    const a = new Error('a')
    const b = new Error('b')
    const { threw, fired } = run([bad(a), bad(b)], [{ name: 'one' }, { name: 'two' }])
    expect(threw).toBe(a)
    expect(fired.length, 'stops at the first — the run is already over').toBe(1)
    expect(fired[0].source).toBe('one')
  })

  it('does nothing when every load succeeded', () => {
    const { threw, fired } = run([ok(), ok()], [{ name: 'a' }, { name: 'b' }])
    expect(threw).toBeNull()
    expect(fired).toEqual([])
  })
})
