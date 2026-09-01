import type { Page } from '@playwright/test'

/**
 * Collect the page errors a spec is actually asserting about.
 *
 * A spec that pushes EVERY console error into one array cannot tell "the draw
 * threw" from "a font CDN was unreachable" (#1916). The playground pages load
 * their webfonts from `fonts.googleapis.com`; where that host is unreachable --
 * a sandboxed container, a corporate proxy, an offline box -- the request is
 * reset, Chromium logs a console error, and an `expect(errors.length).toBe(0)`
 * fails for a reason the spec was never testing.
 *
 * The predicate is the resource's ORIGIN, not its message text. Two specs
 * previously dropped anything containing `Failed to load resource`, which also
 * discards FIRST-party load failures -- a missing sprite sheet, a 404 glyph
 * range, a tile the dev server did not serve -- and those are real defects this
 * corpus exists to catch. Comparing origins keeps them and drops only the
 * third-party fetches no assertion here covers.
 *
 * Uncaught exceptions (`pageerror`) are always kept: they are the page's own by
 * construction, whatever script raised them.
 *
 * Specs that also want non-error console output can register their own
 * additional `page.on('console')` listener -- this one does not consume events.
 */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (isCrossOrigin(page.url(), m.location().url)) return
    errors.push(m.text())
  })
  return errors
}

/**
 * True only when both URLs parse AND their origins differ. Anything unknown or
 * unparseable counts as first-party, so a message whose source cannot be
 * established is still reported -- the fail-safe direction for an error budget.
 */
function isCrossOrigin(pageUrl: string, resourceUrl: string): boolean {
  if (!resourceUrl || !pageUrl) return false
  try {
    const pageOrigin = new URL(pageUrl).origin
    // An opaque origin parses to the string "null" -- `about:blank`, which is
    // where a page sits until its first navigation commits. There is nothing to
    // compare against yet, and an early first-party error is exactly the kind
    // this budget must not lose, so keep it.
    if (pageOrigin === 'null') return false
    return new URL(resourceUrl).origin !== pageOrigin
  } catch {
    return false
  }
}
