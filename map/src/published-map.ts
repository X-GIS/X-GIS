// #2613 — the published surface of `XGISMap`, and the single authority for it.
//
// TWO entry points publish this name and they must not disagree: `index.ts` (the
// internal workspace barrel the playground / site / examples resolve through
// `map/package.json`'s `exports`) and `public.ts` (the curated file
// `dts-bundle.ts` builds `dist/index.d.ts` from). Both re-export from here, so
// widening the surface is one edit in one place — a second list would be exactly
// the two-authorities drift this repo keeps paying for.
//
// Exporting the class exported all 215 of its public members, which defeated the intent
// `render/passes/pass-hosts.ts:1-18` states ("the members stay package-internal
// on XGISMap") at the only boundary that matters. The class stays the
// implementation; `XGISMap` the published name is a type alias over it plus a
// constructor value, so `new XGISMap(canvas)`, `InstanceType<typeof XGISMap>`
// and `instanceof` all keep working.
//
// The list is DERIVED, three ways — a property scan alone is not sufficient:
//   1. every `TS2339` the consumer programs report when this is `never`, iterated
//      to a fixed point (playground/src, examples/, site/);
//   2. the keys of every structural map type in the published surface — only
//      `MarkerMapLike` (marker.ts:34), which `Marker.addTo` / `Popup.addTo` take.
//      Its `getContainer` / `on` / `off` — plus `once`, from the playground's own
//      `SettledLoopMap` — are required by ASSIGNABILITY and appear in no property
//      scan, and their TS2345 names neither the member nor the cause;
//   3. map's own program (`tsc --build map/tsconfig.json`), whose tests are in
//      `include` and reached this barrel — they now import `./map` directly.
// Widening this list is a deliberate act, gated twice: `published-surface.test.ts`
// fails to COMPILE if it and `keyof XGISMap` disagree in either direction, and
// `scripts/map-public-surface.test.ts` reds on the baked `__api__/surface.md`
// diff — the two look at the SOURCE type and the BUNDLED `.d.ts` respectively,
// which is the pair that caught this file needing to exist at all.
import type { XGISMap as XGISMapImpl } from './map'
import { XGISMap as XGISMapCtor } from './map'

/** The published surface of the map. */
export type XGISMap = Pick<XGISMapImpl, PublishedMapMember>

/** The member names {@link XGISMap} publishes. Exported so the guard test and any
 *  future audit read the SAME union the type is built from, rather than a copy. */
export type PublishedMapMember =
  // lifecycle
  | 'run'
  | 'runScene'
  | 'stop'
  | 'destroy'
  | 'invalidate'
  // camera
  | 'getCamera'
  | 'setCenter'
  | 'setZoom'
  | 'setBearing'
  | 'getBearing'
  | 'setPitch'
  | 'jumpTo'
  | 'flyTo'
  | 'fitBounds'
  | 'markCameraPositioned'
  | 'isCameraPositioned'
  | 'project'
  | 'unproject'
  // surface + backend
  | 'getCanvas'
  | 'getCanvasDpr'
  | 'getContainer'
  | 'getBackend'
  | 'getMissingTileCount'
  // events — `on` / `off` / `once` are required by MarkerMapLike and
  // SettledLoopMap through assignability, not by any property access
  | 'on'
  | 'off'
  | 'once'
  // sources + features
  | 'setSourceData'
  | 'setSourcePoints'
  | 'updateFeature'
  | 'setPaintProperty'
  // style roots the host applies (projection / sprites / glyphs / light / sky)
  | 'setProjection'
  | 'setGlyphsUrl'
  | 'setSpriteUrl'
  | 'setLight'
  | 'setAtmosphere'
  | 'setTerrain'
  | 'getTerrain'
  // overlays + graphics
  | 'addOverlay'
  | 'addImage'
  | 'graphics'
  // coverage playback
  | 'getCoverage'
  | 'setCoverageTime'
  | 'playCoverageTime'
  | 'pauseCoverageTime'
  // label debugging — the playground's overlay is a real consumer
  | 'setLabelDebugHook'

// No cast: a constructor's return type is COVARIANT, and the class's instance
// type is assignable to the `Pick` of it, so a plain annotation is enough to
// republish the same constructor under the narrower instance type. (`as unknown
// as` would work too and is what this started as — the forced-cast ratchet was
// right to ask for the seam instead.)
export const XGISMap: {
  new (...args: ConstructorParameters<typeof XGISMapCtor>): XGISMap
} = XGISMapCtor
