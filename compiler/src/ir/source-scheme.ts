// ═══ Source-level `scheme: xyz | tms` — the one predicate (#1985) ═══
//
// Mapbox `source.scheme` declares which end of the world the tile ROWS are numbered
// from: `xyz` (the default) counts from the top, `tms` (OSGeo Tile Map Service) from
// the bottom. Two stages need to agree about what a usable value is: the Mapbox
// converter (which decides whether to emit the property and what to warn when it
// doesn't) and `lowerSource` (which decides whether the parsed `.xgis` literal
// reaches `SourceDef`). Two copies of that rule would drift, so the membership test
// lives here once and each stage renders its own message around `schemeRejectReason`.
//
// GRAMMAR — `scheme: tms` adds no production. `parseBlockProperty` parses a full
// expression, so a bare `tms` arrives as `Identifier` and a quoted `"tms"` as
// `StringLiteral`; both forms already reached `lowerSource`'s property loop before
// this file existed (verified against the real Lexer + Parser). That is the same
// pair `type:` and `encoding:` accept, so the property reads the way a Mapbox author
// wrote it and the converter emits the bare-identifier house form.
//
// UNKNOWN VALUES fall back to `xyz` rather than failing the compile: MapLibre's
// `CanonicalTileID.url()` tests `scheme === 'tms'` and treats every other value —
// a typo, `"XYZ"`, `"wms"` — as the default, so falling back matches the reference
// renderer. The caller warns; a hard error would reject styles MapLibre renders.
//
// `{-y}` IS NOT A SCHEME. The Leaflet/GDAL `{-y}` URL token always means the
// bottom-origin row, independent of `scheme` (Leaflet's `TileLayer.getTileUrl` sets
// `data['-y']` unconditionally). It is a TEMPLATE token, substituted by the runtime
// URL builder (`data/src/tile-select-helpers.ts` `tileUrl`, which carries the full
// decision record), and needs nothing from this file.

import type * as AST from '../parser/ast'

/** Row-origin numbering of a tile pyramid — the Mapbox `scheme` value set. */
export type TileRowScheme = 'xyz' | 'tms'

/** The membership test — the ONE place the legal value set is written down. */
export function isTileScheme(v: unknown): v is TileRowScheme {
  return v === 'xyz' || v === 'tms'
}

/** Why `v` is not a usable scheme — a fragment a caller embeds in its own
 *  diagnostic (`Source "x" declares scheme ${reason}`). Only meaningful for a
 *  value `isTileScheme` rejects. */
export function schemeRejectReason(v: unknown): string {
  const shown = typeof v === 'string' ? `"${v.slice(0, 40)}"` : JSON.stringify(v)?.slice(0, 40)
  return (
    `${shown}, which is neither "xyz" (the default) nor "tms" — the only two values the ` +
    `Mapbox spec defines. Falling back to xyz, which is what MapLibre does with any ` +
    `non-"tms" value; check the spelling`
  )
}

/**
 * Lower an `.xgis` source-block `scheme:` value. Accepts the bare identifier
 * (`scheme: tms`) and the quoted string (`scheme: "tms"`), matching the `type:` /
 * `encoding:` pair. Undefined for anything else — including an unknown value, which
 * lowers to "no declaration" and so keeps the xyz default. That is the same
 * silent-ignore rule its `tileSize` / `maxzoom` siblings in `lowerSource` follow; the
 * author-facing diagnostic for a bad value belongs to the converter, which still has
 * the Mapbox JSON that produced it.
 */
export function lowerSourceScheme(value: AST.Expr): TileRowScheme | undefined {
  let raw: string | undefined
  if (value.kind === 'Identifier') raw = value.name
  else if (value.kind === 'StringLiteral') raw = value.value
  return isTileScheme(raw) ? raw : undefined
}
