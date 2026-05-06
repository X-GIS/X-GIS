// Build-time search index. Imports the same content the docs +
// gallery pages render from, flattens to a list of search records,
// and exposes them as a single array. The Search component embeds
// this array as JSON and runs client-side fuzzy filtering — no
// external service, no runtime fetch.

import { referenceSections } from '../content/reference-sections'
import { galleryCategories, runIdOf } from '../content/gallery-demos'

export interface SearchRecord {
  /** Stable identifier used as React-style key in the result list. */
  id: string
  /** Section / page / demo title. */
  title: string
  /** One-line body excerpt — what the result is, in plain English. */
  body: string
  /** "doc" for docs pages/sections, "demo" for gallery demos. The
   *  result list groups by this. */
  type: 'doc' | 'demo'
  /** Short tag shown beside the title (e.g., "Reference", "Concept",
   *  "API", or the demo category like "Animation"). */
  tag: string
  /** Full URL relative to BASE_URL. */
  url: string
}

/**
 * Build the search index. Pure — pass a `base` so call-sites can use
 * Astro's `import.meta.env.BASE_URL` instead of hard-coding.
 */
export function buildSearchIndex(base: string): SearchRecord[] {
  const out: SearchRecord[] = []

  // ─── Top-level docs pages ───
  out.push({
    id: 'doc:overview',
    title: 'Documentation overview',
    body: 'Quick start, browse cards, and links to every docs sub-page.',
    type: 'doc',
    tag: 'Overview',
    url: `${base}/docs`,
  })
  out.push({
    id: 'doc:concepts/rtc',
    title: 'RTC + DSFUN precision',
    body: 'How X-GIS preserves f32 precision at any camera zoom by splitting Mercator-meter coordinates into f64-equivalent high-low pairs.',
    type: 'doc',
    tag: 'Concept',
    url: `${base}/docs/concepts/rtc`,
  })
  out.push({
    id: 'doc:concepts/projections',
    title: 'Projection switching',
    body: 'Seven projections, one source. Switching is a single GPU uniform write — no re-tessellation.',
    type: 'doc',
    tag: 'Concept',
    url: `${base}/docs/concepts/projections`,
  })
  out.push({
    id: 'doc:concepts/pipeline',
    title: 'Compile pipeline',
    body: 'Lexer → AST → IR → optimizer → WGSL codegen. The path from .xgis source to a frame.',
    type: 'doc',
    tag: 'Concept',
    url: `${base}/docs/concepts/pipeline`,
  })
  out.push({
    id: 'doc:api',
    title: 'JavaScript API',
    body: 'Public exports from @xgis/runtime: XGISMap, Camera, projections, loaders, compute helpers, stats, custom element.',
    type: 'doc',
    tag: 'API',
    url: `${base}/docs/api`,
  })
  out.push({
    id: 'doc:utilities',
    title: 'Utility catalog',
    body: 'Tailwind-style utility classes: colors, fills, strokes, opacity, sizes, shapes, animation, modifiers.',
    type: 'doc',
    tag: 'Utilities',
    url: `${base}/docs/utilities`,
  })

  // ─── Reference sections (one record per section so search lands
  //     on the exact heading via #anchor) ───
  for (const s of referenceSections) {
    out.push({
      id: `ref:${s.id}`,
      title: s.title,
      body: s.body,
      type: 'doc',
      tag: 'Reference',
      url: `${base}/docs/reference#${s.id}`,
    })
  }

  // ─── Gallery demos (every card becomes one record) ───
  // Mirror the production gallery's devOnly filter — search results
  // should reflect what's visible on the page they link to.
  const includeDevOnly = import.meta.env.DEV
  for (const cat of galleryCategories) {
    for (const d of cat.demos) {
      if (!includeDevOnly && d.devOnly) continue
      out.push({
        id: `demo:${d.id}`,
        title: d.title,
        body: d.body,
        type: 'demo',
        tag: cat.title,
        url: `${base}/examples#${d.id}`,
      })
    }
  }

  return out
}

/** Returns a JSON-encoded string suitable for embedding in an
 *  Astro `<script type="application/json">` block. */
export function buildSearchIndexJSON(base: string): string {
  return JSON.stringify(buildSearchIndex(base))
}
