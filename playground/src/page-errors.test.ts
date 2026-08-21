import { describe, it, expect } from 'vitest'
import type { Page } from '@playwright/test'
import { collectPageErrors } from '../e2e/_page-errors'

/**
 * #1916: the e2e error budget must distinguish "the page threw" from "a
 * third-party CDN was unreachable". These run here, not in Playwright, because
 * the predicate is pure -- and because a browser probe of it costs 30 s and
 * only runs when someone remembers to run it.
 */

type Listener = (arg: unknown) => void

function fakePage(pageUrl: string) {
  const listeners: Record<string, Listener[]> = {}
  const page = {
    on: (event: string, fn: Listener) => {
      ;(listeners[event] ??= []).push(fn)
    },
    url: () => pageUrl,
  } as unknown as Page

  return {
    page,
    console(type: string, text: string, locationUrl: string) {
      for (const fn of listeners.console ?? [])
        fn({ type: () => type, text: () => text, location: () => ({ url: locationUrl }) })
    },
    pageerror(message: string) {
      for (const fn of listeners.pageerror ?? []) fn({ message })
    },
  }
}

const PAGE = 'https://localhost:3000/demo.html?id=fixture_sdf_point&e2e=1'

describe('collectPageErrors', () => {
  it('drops the third-party font-CDN failure that #1916 was filed for', () => {
    const f = fakePage(PAGE)
    const errors = collectPageErrors(f.page)
    f.console(
      'error',
      'Failed to load resource: net::ERR_CONNECTION_RESET',
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap',
    )
    expect(errors).toEqual([])
  })

  // The distinguishing case. Byte-identical message text to the one above, so a
  // text-substring filter -- what two CI-registered gates used to do -- returns
  // the same verdict for both. Only the ORIGIN separates them, and a same-origin
  // load failure (a missing sprite sheet, a 404 glyph range, a tile the server
  // did not serve) is a real defect this corpus exists to catch.
  it('keeps a SAME-ORIGIN load failure with the exact same message text', () => {
    const f = fakePage(PAGE)
    const errors = collectPageErrors(f.page)
    f.console(
      'error',
      'Failed to load resource: net::ERR_CONNECTION_RESET',
      'https://localhost:3000/sprites/basemap.png',
    )
    expect(errors).toEqual(['Failed to load resource: net::ERR_CONNECTION_RESET'])
  })

  it('keeps a first-party console.error', () => {
    const f = fakePage(PAGE)
    const errors = collectPageErrors(f.page)
    f.console('error', 'WebGL: INVALID_OPERATION', 'https://localhost:3000/src/map.ts')
    expect(errors).toEqual(['WebGL: INVALID_OPERATION'])
  })

  it('always keeps an uncaught exception, whatever script raised it', () => {
    const f = fakePage(PAGE)
    const errors = collectPageErrors(f.page)
    f.pageerror('TypeError: cannot read properties of undefined')
    expect(errors).toEqual(['TypeError: cannot read properties of undefined'])
  })

  it('ignores console output that is not an error', () => {
    const f = fakePage(PAGE)
    const errors = collectPageErrors(f.page)
    f.console('log', 'POINTRHI drew 42', 'https://localhost:3000/src/map.ts')
    f.console('warning', 'deprecated', 'https://localhost:3000/src/map.ts')
    expect(errors).toEqual([])
  })

  // Same fail-safe direction, one step earlier: a page sits on `about:blank`
  // until its first navigation commits, and `about:blank` has an opaque origin
  // that parses to the string "null". Comparing against it would make EVERY
  // early error look cross-origin and vanish.
  it('keeps an error that arrives before the page has an origin', () => {
    const f = fakePage('about:blank')
    const errors = collectPageErrors(f.page)
    f.console('error', 'boot threw', 'https://localhost:3000/src/map.ts')
    expect(errors).toEqual(['boot threw'])
  })

  // Fail-safe direction: an error whose source cannot be established is still
  // reported. Silently dropping it is how an error budget rots.
  it('keeps an error whose location is empty or unparseable', () => {
    const f = fakePage(PAGE)
    const errors = collectPageErrors(f.page)
    f.console('error', 'no location', '')
    f.console('error', 'garbage location', 'not-a-url')
    expect(errors).toEqual(['no location', 'garbage location'])
  })
})
