// #1364 — a source whose manifest will not load must be REPORTABLE.
//
// THE DEFECT THIS PINS: `attachTo` soft-fails when `resolve()` returns null —
// the catalog stays empty and the rest of the map keeps loading. That default is
// right, but it was also SILENT: the failure reached `console.error` and nothing
// else. An embedding app therefore saw a map reporting itself perfectly healthy
// (`loaded() === true`, `missedTiles: 0` — nothing was requested, so nothing was
// missed) with its only data source dead, and had no way to detect it, let alone
// name the layer to warn about.
//
// WHAT IS DELIBERATELY *NOT* CHANGED: the soft-fail itself. `attachPMTilesSource`
// must still resolve rather than throw, and the catalog must still come back
// empty rather than half-built. Reporting a failure is not the same as promoting
// it, and the asserts below pin both halves so a future "fix" cannot quietly
// turn this into a hard failure.

import { describe, expect, it } from 'vitest'
import { TileCatalog } from './tile-catalog'
import { attachPMTilesSource } from './vector-tile-loader'

/** Run `fn` with `fetch` failing the way an unreachable or CORS-blocked host
 *  does — a REJECTED promise, not an error status. That distinction matters:
 *  the CORS case is the one whose cause used to vanish entirely. */
async function withDeadNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = prior
  }
}

describe('a soft-failed source resolve is reported, not swallowed (#1364)', () => {
  it('calls onResolveError with the cause when a TileJSON manifest is unreachable', async () => {
    const catalog = new TileCatalog()
    const seen: unknown[] = []

    await withDeadNetwork(() =>
      attachPMTilesSource(catalog, {
        // A public host so the SSRF literal check passes and the real resolve
        // path is reached.
        url: 'https://tiles.example.com/v4.json',
        kind: 'tilejson',
        onResolveError: (e) => seen.push(e),
      }),
    )

    expect(seen.length, 'exactly one report for one dead source').toBe(1)
    expect(seen[0], 'the cause must survive — a bare notification is not enough').toBeInstanceOf(
      Error,
    )
    expect(String((seen[0] as Error).message)).toMatch(/fetch/i)
  })

  it('still soft-fails: the attach resolves and the catalog stays empty', async () => {
    const catalog = new TileCatalog()
    let threw = false

    await withDeadNetwork(async () => {
      try {
        await attachPMTilesSource(catalog, {
          url: 'https://tiles.example.com/v4.json',
          kind: 'tilejson',
          onResolveError: () => {},
        })
      } catch {
        threw = true
      }
    })

    expect(threw, 'reporting must not convert the soft-fail into a throw').toBe(false)
    expect(catalog.hasData(), 'a failed attach must not leave a half-built catalog').toBe(false)
  })

  it('is optional — omitting the callback keeps the old behaviour exactly', async () => {
    // The seam is additive: every existing caller passes nothing and must be
    // unaffected, including not crashing on the missing callback.
    const catalog = new TileCatalog()
    let threw = false

    await withDeadNetwork(async () => {
      try {
        await attachPMTilesSource(catalog, {
          url: 'https://tiles.example.com/v4.json',
          kind: 'tilejson',
        })
      } catch {
        threw = true
      }
    })

    expect(threw).toBe(false)
  })
})
