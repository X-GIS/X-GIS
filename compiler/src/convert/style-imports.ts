// ═══ Mapbox v3 `imports` → xgis import statements (#2471) ═══
//
// Nothing here is new machinery. `resolveImportsAsync` (module/resolver.ts:249)
// already fetches a path through the host's SSRF-guarded reader, and
// `parseModuleSource` (:365) already re-enters `convertMapboxStyle` on anything
// it fetches that `looksLikeMapboxStyle` — recursively, with cycle detection, a
// resolved-once memo and name-collision errors. The converter simply never
// emitted the statement that reaches them, so `imports` rode the lumped
// `Top-level style fields ignored:` warning beside `models`. For a v3 Standard
// style the import IS the basemap, which made "ignored" understate the loss to
// the point of being misleading.
//
// Its own module because `mapbox-to-xgis.ts` is at its 800-line ceiling
// (`map/src/loc-ceiling-ratchet.test.ts`) — the same reason `expand-color-
// match.ts` and `collator-opts.ts` sit beside it rather than inside it.

/** Emit a style's `imports` root as xgis `import "<url>"` statements, appending
 *  them (plus the blank-line separator) to `lines` and pushing a warning per
 *  entry that cannot resolve.
 *
 *  Owns the emit fragment rather than returning it, so the whole of what
 *  `imports` contributes to the output lives here — `mapbox-to-xgis.ts` is at
 *  its LOC ceiling and every line of this belongs to one feature. Emit position
 *  is decided by the CALLER and is load-bearing rather
 *  than cosmetic: the resolver splices an import's statements at the import's
 *  own line, so emit order is draw order — the imported basemap has to land
 *  UNDER the root style's own layers, which is Mapbox's default placement when
 *  no `slot` is used.
 *
 *  Three forms cannot resolve and each warns naming its own entry, never the
 *  lump: a `mapbox://` url (needs the Mapbox API + an access token, the same
 *  gap the sprite/glyphs check reports), an inline `data` style object (the
 *  resolver reads by PATH, so there is nothing to fetch), and a malformed
 *  entry. `config` warns but still imports — dropping the basemap over a
 *  dropped option switch would be the original bug again. */
export function emitStyleImports(raw: unknown, lines: string[], warnings: string[]): void {
  if (raw === undefined || raw === null) return
  if (!Array.isArray(raw)) {
    warnings.push(
      `Top-level "imports" is malformed (expected an array, got ${typeof raw}) and is ignored.`,
    )
    return
  }

  const importLines: string[] = []
  raw.forEach((entry, i) => {
    const isObj = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    const e = isObj ? (entry as { id?: unknown; url?: unknown; config?: unknown }) : {}
    // The entry's own name for messages. `id` is required by the spec; fall
    // back to the index so a malformed entry is still locatable.
    const label = typeof e.id === 'string' && e.id !== '' ? `"${e.id}"` : `at index ${i}`

    if (!isObj) {
      warnings.push(
        `Style import ${label} is malformed (expected an object, got ` +
          `${entry === null ? 'null' : typeof entry}) and is ignored.`,
      )
      return
    }

    const url = typeof e.url === 'string' ? e.url : undefined
    if (url === undefined) {
      // `data` — an inline style object in place of a url. The wire this lowers
      // onto reads by path, so there is nothing for it to fetch; converting the
      // object in place is a separate increment.
      const hasData = 'data' in (entry as Record<string, unknown>)
      warnings.push(
        hasData
          ? `Style import ${label} supplies an inline "data" style object instead of a "url" — ` +
              `not imported. X-GIS resolves an import by fetching its path, so an inline style ` +
              `has nothing to fetch; publish it at a URL and reference that instead.`
          : `Style import ${label} declares neither "url" nor "data" and is ignored.`,
      )
      return
    }

    if (/^mapbox:\/\//i.test(url)) {
      warnings.push(
        `Style import ${label} points at "${url.slice(0, 80)}", which requires the Mapbox API ` +
          `and an access token — not imported; host a MapLibre-compatible style JSON or point ` +
          `at an https URL.`,
      )
      return
    }

    // The path lands inside a double-quoted xgis string literal, so a `"` or
    // newline in it would end the statement early and corrupt the emit. A URL
    // cannot legally contain either; reject rather than escape, so a malformed
    // one is named instead of silently reshaped.
    //
    // Checked BEFORE the `config` warning below, which promises "the import
    // itself still resolves" — a warning that would be false for an entry
    // rejected here.
    if (/["\r\n]/.test(url)) {
      warnings.push(`Style import ${label} has a url containing a quote or newline and is ignored.`)
      return
    }

    if (e.config !== undefined && e.config !== null) {
      warnings.push(
        `Style import ${label} carries "config" options, which have no X-GIS equivalent and ` +
          `are dropped — the imported style renders with its own defaults. The import itself ` +
          `still resolves.`,
      )
    }

    importLines.push(`import "${url}"`)
  })

  if (importLines.length > 0) {
    lines.push(...importLines)
    lines.push('')
  }
}
