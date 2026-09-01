// ═══ Forwarding an imported style's top-level host fields (#1112, #2121) ═══
//
// The one-line `import "<style.json>"` path fetches the raw style JSON INSIDE
// `resolveImportsAsync` and hands it straight to the converter, so the host
// never sees `style.sprite` / `style.glyphs` to call `setSpriteUrl` /
// `setGlyphsUrl` itself — and the converter omits both from the emitted DSL by
// design, on the stated grounds that they are host-integration concerns
// (`compiler/src/convert/spec-coverage/top-level.ts`). On this path the
// out-collector IS the importer, so a field with no slot here is silently
// dropped: #1112 was that bug for `sprite`, #2121 the same bug for `glyphs`.
//
// Both wires live here rather than inline in `map.ts` so the pair stays one
// concern with one rationale — the way they drifted apart is what produced two
// issues instead of one.

/** What `resolveImportsAsync` fills from the imported style's raw JSON.
 *  Mirrors `ConvertMapboxStyleOptions.topLevel`. */
export interface ImportedTopLevel {
  sprite?: string
  glyphs?: string
}

/** The subset of `XGISMap` these wires touch. Structural on purpose: importing
 *  the class here would be circular. */
export interface TopLevelHost {
  spriteUrl: string | null
  glyphsUrl: string | null
}

/** Apply an imported style's top-level URLs, filling only still-null slots.
 *
 *  The guards are not defensive padding: an explicit constructor option or a
 *  host `setSpriteUrl` / `setGlyphsUrl` has already won on the host-object
 *  import path, and a runtime-internal import must never clobber a host-chosen
 *  atlas or fontstack.
 *
 *  TIMING, and the asymmetry between the two. `sprite` must ALSO be seeded as a
 *  constructor option by hosts that can: by the time this runs, `IconStage`'s
 *  first-frame gate (`spriteUrl !== null`) may already have decided. `glyphs`
 *  has no such problem — `TextStage` is built lazily on the first label-bearing
 *  frame and reads `host.glyphsUrl` at that moment
 *  (`render/passes/label-pass.ts:322-329`), which is strictly after this call.
 *  Without the glyphs wire, `text/glyph-rasterizer-wiring.ts:49` takes the
 *  plain-Canvas2D branch and no `GlyphPbfCache` is ever constructed, so every
 *  style-import scene draws its labels in system fonts. */
export function applyImportedTopLevel(host: TopLevelHost, imported: ImportedTopLevel): void {
  if (imported.sprite !== undefined && host.spriteUrl === null) host.spriteUrl = imported.sprite
  if (imported.glyphs !== undefined && host.glyphsUrl === null) host.glyphsUrl = imported.glyphs
}
