// ═══ Line/point label dedupe + pair-key helpers (extracted from label-pass, #1003 ceiling) ═══
//
// Pure, GPU-free key/predicate helpers the label placement walk closes over.
// Extracted verbatim so label-pass.ts stays under its LOC ceiling; label-pass
// re-exports them, so existing importers (tests included) are unaffected.

import { resolveText } from '../../text/text-resolver'

/** Cross-tile line-label dedupe predicate. A named road stamped across N
 *  tile boundaries collapses to a single label via its (unique) resolved
 *  text. But TEXT-LESS icon-only line layers — OFM `road_oneway` arrows
 *  have an `icon-image` and NO `text-field` — resolve to `''` for every
 *  along-line stop, so an empty key must NEVER dedupe: otherwise the first
 *  arrow records `''` and every later stop (this polyline + every other
 *  one-way segment in the show) sees `has('')` → suppressed, collapsing the
 *  whole layer to ~one arrow on screen. Only non-empty (named) keys collapse.
 *  Exported for unit coverage — the placement loop is an anon callback. */
export function lineLabelDeduped(resolvedText: string, emitted: ReadonlySet<string>): boolean {
  if (resolvedText === '') return false
  return emitted.has(resolvedText)
}

/** #603 — does a line-placed symbol render NO text (icon-only)? Gates the
 *  cross-tile icon dedup (isLineIconDuplicate): only TEXT-LESS line icons
 *  (OFM `road_oneway` arrows, icon-only shields) need it — a text+icon pair
 *  is already deduped by its text name and must not drop its icon out from
 *  under its number.
 *
 *  The predicate is the RESOLVED text being empty, NOT `text === undefined`:
 *  the compiler emits `text: '""'` for an icon-only symbol (symbol.ts
 *  `labelExpr = '""'`), so `LabelDef.text` is a non-null empty template and
 *  a `text !== undefined` test is ALWAYS true → the dedup never armed and
 *  road_oneway arrows duplicated at tile seams (#603). Resolve `text` here so
 *  an empty-rendering symbol is correctly detected. Exported for coverage —
 *  the placement walk is an anon callback. */
export function lineIconIsIconOnly(
  text: import('@xgis/compiler').TextValue | undefined,
  props: import('../../text/text-resolver').FeatureProps,
  cameraZoom: number,
): boolean {
  if (text === undefined || text === null) return true
  return resolveText(text, props, cameraZoom) === ''
}

/** #605 — the cross-tile dedupe key for a tangent-rotated (curved) line label.
 *  Caps repeated along-line placements to one per route per ShowCommand pass
 *  (via isTooCloseToSameText / lineLabelDeduped), so the choice of key decides
 *  what counts as "the same route".
 *
 *  A route-number SHIELD (text+icon line symbol — OFM highway-shield-*, whose
 *  text-field is the route `ref`, e.g. "82") is identified by its REF, NOT the
 *  road `name`: a national route overlays many differently-named OSM road
 *  segments (some carry a street `name`, some only `ref`), so a `name`-keyed
 *  dedupe diverges per segment and stamps the same "82" shield once per distinct
 *  name across the tiles the route fills — ~6× at z19 vs MapLibre's ~1× (the ref
 *  is the same on every segment, so resolving the drawn text collapses the whole
 *  route to one shield). The ref is monolingual so the bilingual-divergence
 *  concern below does not apply to it.
 *
 *  A plain road-NAME label (no paired icon) keeps the `name` → `name_en` →
 *  resolved-text precedence: resolveText() varies across segments when one
 *  carries `name:nonlatin` and the next doesn't (the bilingual concat returns
 *  different strings for the same road), so the raw name field is the stabler
 *  cross-segment key there. Exported for coverage — the placement walk is an
 *  anon callback. */
export function lineLabelDedupeKey(
  pairedWithIcon: boolean,
  text: import('@xgis/compiler').TextValue,
  props: import('../../text/text-resolver').FeatureProps,
  cameraZoom: number,
): string {
  if (pairedWithIcon) return resolveText(text, props, cameraZoom)
  const p = props as Record<string, unknown>
  if (typeof p.name === 'string') return p.name
  if (typeof p.name_en === 'string') return p.name_en
  return resolveText(text, props, cameraZoom)
}

/** Stable per-instance pair key for a POINT label's text+icon (the place-name
 *  dot). Keyed on a monotonic per-show sequence index — NOT the rounded screen
 *  position the pre-#419 code used, whose sub-pixel-drift rounding flipped so a
 *  dot's key collided with a NEIGHBOUR label's dropped key and the dot blinked
 *  on pan/zoom. The text and its dot share one dispatch's key (pairing intact,
 *  iter-119); each instance / world-copy gets a distinct index. No position arg
 *  ⇒ two co-located labels can NEVER collide by construction (the #419 root).
 *  Mirrors the line path's `_lineLabelSeq` (iter-176). Exported for coverage. */
export function pointLabelPairKey(layerName: string | undefined, seq: number): string {
  return `${layerName ?? ''}:pt${seq}`
}

// #458: emit a point-label dedup key when unclaimed or from a strictly HIGHER layer (top-wins); same/lower → drop.
export const shouldEmitPointDedup = (prev: number | undefined, showIdx: number): boolean =>
  prev === undefined || showIdx > prev

/** #727 (C) — copy-suffix a cross-tile dedupe/spacing key for a non-canonical
 *  world copy. The text dedupe and same-route spacing identities are copy-BLIND
 *  by design (one route = one cadence); a wrapped world copy is a legitimate
 *  SECOND appearance of the route, so each copy gets its own key space. `wo` 0
 *  (the canonical copy — and every pre-#727(C) call path) returns the key
 *  unchanged; empty keys stay empty (icon-only symbols never dedupe by text). */
export function lineLabelCopyKey(key: string, wo: number): string {
  if (wo === 0 || key === '') return key
  return `${key}\u0000w${wo}`
}
