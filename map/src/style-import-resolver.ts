// ═══ Resolving `import { … } from "<url>"` inside a style ═══
//
// A style may import another style by URL, so this is a fetch of attacker-influenced
// input on the map's own origin — the SSRF guard and the body cap are the load-bearing
// parts, not the decoding. Every failure resolves to `null` (the import contributes
// nothing, exactly as a 404 would) and is logged via `xlog.error`, which reaches the
// in-page overlay: a module-resolution failure that is silent on iOS is the shape this
// was written against.
//
// Extracted from map.ts, a shrink-only god-file, when #1577 needed room beside it.

import { safeFetch, readBodyCapped, assertNotErrorPage } from '@xgis/shared'
import { xlog } from '@xgis/shared'

/** Hard cap on one imported style module. A lying or absent Content-Length otherwise lets
 *  an unbounded `.text()` OOM the tab. Same 32 MB budget map.ts applies to a top-level
 *  `.xgis` fetch — an imported module is the same kind of input arriving the same way. */
const MAX_STYLE_BYTES = 32 * 1024 * 1024

/** A resolver bound to `absBase`, in the shape `resolveImportsAsync` expects. */
export function makeStyleImportResolver(absBase: string): (path: string) => Promise<string | null> {
  return async (path: string): Promise<string | null> => {
    let url: string
    try {
      url = new URL(path, absBase).href
    } catch (e) {
      xlog.error(
        `[X-GIS import] cannot build URL for "${path}" against base "${absBase}":`,
        (e as Error).message,
      )
      return null
    }
    try {
      // SSRF guard: an imported style can `import { … } from "<url>"` —
      // block private/loopback/non-http(s) targets before fetch, AND
      // re-check every redirect hop (safeFetch follows manually) so an
      // allowlisted host can't 302 to an internal address. Throws into
      // the catch below → null (the import resolves to nothing, same as a
      // 404), so an attacker can't probe internal hosts.
      const resp = await safeFetch(url, undefined, 'style import URL')
      if (!resp.ok) {
        xlog.error(`[X-GIS import] fetch ${url} failed: ${resp.status} ${resp.statusText}`)
        return null
      }
      // Cap the module body — a lying/absent Content-Length otherwise lets
      // an unbounded .text() OOM the tab.
      const bytes = await readBodyCapped(resp, MAX_STYLE_BYTES, `style import ${url}`)
      // A MISSING module is not a 404 on most hosts — an SPA fallback answers
      // 200 with an HTML page, which `resp.ok` above waves through and the
      // lexer then reports as a syntax error at a line inside HTML (#1627).
      // Throwing here lands in the catch below → `null`, which is exactly what
      // `resolveImportsAsync` needs to raise `[Module] Could not read file
      // "<path>" (imported by <importer> at line N)` — the message that names
      // the import site instead of a position in a file nobody wrote.
      assertNotErrorPage(resp, bytes, `style import ${url}`)
      return new TextDecoder().decode(bytes)
    } catch (e) {
      xlog.error(`[X-GIS import] fetch ${url} threw:`, (e as Error).message)
      return null
    }
  }
}
