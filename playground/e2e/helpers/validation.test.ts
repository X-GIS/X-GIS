// ═══ The realm withValidationCapture used to lose (#2352) ═══
//
// `getValidationErrors` is a `page.evaluate`: it can only read the queue of the
// JS realm that is live at the moment it runs. The wrapper read ONCE, after the
// whole body — so any cross-document `page.goto` inside the body destroyed the
// previous realm, and its queue with it, unread. `reftest.spec.ts` loads two
// fixtures and validated only the second; `_inline-match-virt.spec.ts` loads
// three routes and validated only the third. Both reported green over a
// fraction of what they claim to cover.
//
// Why this lives in vitest and not in a spec: an end-to-end arm would have to
// PROVOKE a real WebGPU validation error in fixture A and none in fixture B,
// which means shipping a deliberately broken fixture to prove a harness point.
// The browser fact the wrapper depends on is one sentence long — `evaluate`
// runs against the current realm, and a navigation installs a fresh one — so it
// is cheaper to model that sentence exactly and drive the REAL helper against
// it. Everything else (frames, CDP, the GPU) is irrelevant to the contract
// under test.
//
// The arms and what each one distinguishes:
//   1. CONTROL — one realm, one error, the wrapper throws. Non-vacuity: it
//      proves the fake can carry an error into the assertion at all.
//   2. the reftest shape — an error fired in realm A, then a navigation to B.
//      Reds if the checkpoint API is absent, and reds again if a later change
//      keeps `checkpoint` but stops UNIONING its drain into the final
//      assertion (the queue is read and thrown away, the final realm is
//      clean, the wrapper resolves).
//   3. the guard — a body that navigates twice with NO checkpoint must FAIL
//      naming the gap, so the silent false negative cannot come back through a
//      caller nobody has written yet.
//   4. the false-positive check — a properly checkpointed multi-navigation
//      body must still resolve, and with the body's value.

import { describe, it, expect } from 'vitest'
import type { Page } from '@playwright/test'
import { withValidationCapture, type CapturedValidationError } from './validation'

/** The page-side shape the helper reads. */
type Realm = { __xgisMap?: { ctx?: { _validationErrors?: CapturedValidationError[] } } }

/** A fake `Page` modelling exactly one browser fact: `evaluate` runs against
 *  the realm that is live NOW, and a cross-document navigation installs a fresh
 *  one (firing DOMContentLoaded) while the old one — queue included — becomes
 *  unreachable. */
function fakeBrowser() {
  // The pre-navigation realm. `about:blank` carries no map and no queue, which
  // is what makes a checkpoint before the FIRST goto a no-op.
  let realm: Realm = {}
  const documentListeners = new Set<() => void>()

  const page = {
    evaluate: async <R>(fn: () => R): Promise<R> => {
      // The helper's page functions close over the free identifier `window`;
      // in the browser that resolves to the realm. Point the global at the
      // live realm for exactly the duration of the call. (This globalThis
      // write is why the file is quarantined in vitest.config.ts's ISOLATED.)
      // Both page functions in validation.ts are synchronous, so restoring in
      // `finally` restores after the read has actually happened.
      const g = globalThis as unknown as { window?: unknown }
      const had = 'window' in g
      const previous = g.window
      g.window = realm
      try {
        return fn()
      } finally {
        if (had) g.window = previous
        else delete g.window
      }
    },
    on: (event: string, listener: () => void): void => {
      if (event === 'domcontentloaded') documentListeners.add(listener)
    },
    off: (event: string, listener: () => void): void => {
      if (event === 'domcontentloaded') documentListeners.delete(listener)
    },
  }

  return {
    page: page as unknown as Page,
    /** A cross-document navigation: a fresh realm with an empty queue, the old
     *  one gone, and the DOMContentLoaded the wrapper counts. */
    goto(): void {
      realm = { __xgisMap: { ctx: { _validationErrors: [] } } }
      for (const listener of [...documentListeners]) listener()
    },
    /** The engine pushing a validation error onto the LIVE realm's queue. */
    fire(message: string): void {
      const queue = realm.__xgisMap?.ctx?._validationErrors
      if (!queue) throw new Error('fire() before goto(): there is no realm to fire into')
      queue.push({ message, t: queue.length })
    },
    /** Live `domcontentloaded` listeners — a leak would show up here. */
    listeners: () => documentListeners.size,
  }
}

/** Run the wrapper and return the message it threw, or null if it resolved. */
async function failure(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (err) {
    return (err as Error).message
  }
}

describe('withValidationCapture — the realms a multi-navigation body leaves behind (#2352)', () => {
  it('CONTROL: an error fired in the only realm the body visits is reported', async () => {
    const browser = fakeBrowser()

    const message = await failure(
      withValidationCapture(browser.page, async () => {
        browser.goto()
        browser.fire('control: bind group 0 not set')
      }),
    )

    expect(message, 'the wrapper must fail on a validation error in the live realm').toContain(
      'control: bind group 0 not set',
    )
    expect(browser.listeners(), 'the document listener must be detached').toBe(0)
  })

  it('reports an error fired in a realm the body then navigated away from', async () => {
    const browser = fakeBrowser()

    // The reftestPair shape: load A, then load B, then assert once at the end.
    const message = await failure(
      withValidationCapture(browser.page, async (checkpoint) => {
        await checkpoint() // before the first goto there is nothing to drain
        browser.goto() // fixture A
        browser.fire('A: pipeline vertex buffer slot 1 not bound')
        await checkpoint() // drains A while its realm is still alive
        browser.goto() // fixture B — A's realm and queue are gone
        browser.fire('B: bind group layout mismatch')
      }),
    )

    expect(
      message,
      'fixture A is half of what a reftest compares — its validation errors must survive the navigation to B',
    ).toContain('A: pipeline vertex buffer slot 1 not bound')
    expect(message, 'the surviving realm is still reported too').toContain(
      'B: bind group layout mismatch',
    )
    expect(message, 'both realms are aggregated into one report').toContain('(2)')
  })

  it('a body that navigates without checkpointing FAILS instead of dropping the realm', async () => {
    const browser = fakeBrowser()

    const message = await failure(
      withValidationCapture(browser.page, async () => {
        browser.goto()
        browser.fire('A: this queue dies with its realm')
        browser.goto()
      }),
    )

    expect(message, 'a realm destroyed unread must be named, not swallowed').toContain(
      'navigated 2 time(s) but took 0 checkpoint(s)',
    )
    expect(message).toContain('1 realm(s)')
    expect(browser.listeners(), 'the document listener must be detached').toBe(0)
  })

  it('a checkpointed multi-navigation body with no errors still resolves, with its value', async () => {
    const browser = fakeBrowser()

    const captured = await withValidationCapture(browser.page, async (checkpoint) => {
      await checkpoint()
      browser.goto()
      await checkpoint()
      browser.goto()
      return 'both fixtures clean'
    })

    expect(captured, 'the guard must not red a body that drains every realm').toBe(
      'both fixtures clean',
    )
  })
})
