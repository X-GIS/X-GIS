// ═══ #1683 — the SINGLE authority for the window globals the e2e specs probe ═══
//
// Eighteen specs each carried their own `declare global { interface Window { … } }`
// with a differently-shaped `__xgisMap`. Global augmentations merge program-wide, so
// under a real `tsc -p playground/e2e` that is one TS2717 per duplicate plus a TS2339
// for every member a spec reads that ITS OWN copy happened to omit. The declarations
// now live here, once, as the UNION of every member any spec touches; the specs keep
// their local narrowing at the read site (`as`, `!`) and declare nothing globally.
//
// Deliberately a SCRIPT declaration file — no top-level import/export, so `interface
// Window` merges into the global scope directly and no `declare global` wrapper is
// needed. That is also what makes the Vite module shims at the bottom legal: inside a
// MODULE file `declare module '…'` is a module *augmentation* and must resolve to an
// existing module, which a server-absolute Vite specifier never does.
//
// Typing policy: members the specs read structurally are typed structurally; opaque
// runtime internals (`source`, `_selection`, the gpuCache payload) are `any` on
// purpose. These are diagnostic reach-ins to TS-private renderer state, and ~14 other
// specs assert `window as { __xgisMap?: <their own narrow shape> }` — a type assertion
// is only legal while the two shapes stay COMPARABLE, which a speculative deep type
// here would silently break. `any` keeps every one of those narrowings valid.

/** Per-source vector-tile renderer, as the diagnostic specs reach into it. */
interface XgisVtRenderer {
  /** The tile catalogue behind this renderer (`backends`, `dataCache`, …). */
  source?: any
  /** Tile-selection state: `_hysteresisZ`, `frameTileCache()`, … */
  _selection?: any
  _hysteresisZ?: number
  _frameDrawnByZoom?: Map<number, number>
  _frameTileCache?: { tiles?: { z: number; x: number; y: number }[] }
  /** Globe vector-drape baked-fill cache (#599 I3). */
  _drape?: { baked?: { size?: number } } | null
  gpuCache?: Map<string, Map<number, any>>
  stagingPool?: any
  doUploadTile?: any
  getDrawStats?: () => {
    tilesVisible: number
    drawCalls: number
    triangles?: number
    lines?: number
    missedTiles?: number
  }
  getLastDecisionCounts?: () => Record<string, number>
  getPendingUploadCount?: () => number
}

/** Camera hooks. zoom/centerX/centerY are always present — specs assign and read them
 *  unguarded; pitch/bearing are projection-dependent and read through `?? 0`. */
interface XgisCameraTestHooks {
  zoom: number
  centerX: number
  centerY: number
  pitch?: number
  bearing?: number
}

/** The union of every `window.__xgisMap` member the e2e specs touch. */
interface XgisMapTestHooks {
  vtSources: Map<string, { renderer: XgisVtRenderer; source?: any }>
  camera: XgisCameraTestHooks
  inspectPipeline?: () => {
    sources: Array<{
      name: string
      cache: { size: number; pendingLoads: number; pendingUploads: number }
      frame: { tilesVisible: number; missedTiles: number }
    }>
  }
  // Public map surface reached from specs that narrow `window` to their own shape.
  addEventListener?: (type: string, handler: (e: unknown) => void) => void
  getLayer?: (name: string) => any
  getLayers?: () => any
  pickAt?: (x: number, y: number) => Promise<unknown>
  invalidate?: () => void
}

interface Window {
  __xgisMap?: XgisMapTestHooks
  __xgisReady?: boolean
  /** Arms the runtime's per-frame visibility/fallback invariant (throws on violation). */
  __XGIS_INVARIANTS?: boolean
  /** Pins the per-frame tile upload budget; `undefined` restores the default. */
  __XGIS_UPLOAD_BUDGET?: number
  /** Arms a one-frame GPU draw-order capture; the frame publishes __xgisDrawOrderResult. */
  __xgisCaptureDrawOrder?: boolean
  __xgisDrawOrderResult?: Array<{
    seq: number
    slice: string
    phase: string
    extrude: string
    tileKey?: number
    isFill?: boolean
  }>
}

// ── Vite-resolved dynamic imports ────────────────────────────────────────────────
// Specs `await import('/e2e/_webgl2-proof.ts')` and `await import('/src/demos.ts')`.
// Those are server-absolute URLs the dev server resolves at run time; they are opaque
// to static analysis by construction, so `any` is the honest type, and every call site
// already casts the result to the shape it expects. Both are written as WILDCARD
// patterns — a server-absolute specifier reads as a rooted path, which the exact
// ambient-module lookup skips; the pattern table is what actually matches it.
declare module '/e2e/*' {
  const mod: any
  export = mod
}
declare module '/src/*' {
  const mod: any
  export = mod
}

// data/src's worker pools (dragged in transitively by specs that import
// data/src/geojson.ts and friends) import their compile workers with Vite's
// `?worker` query suffix — a bundled Worker constructor at build time, opaque
// to tsc. data/src/worker-shims.d.ts already declares this for data/tsconfig's
// own program, but that file sits outside playground/e2e/'s `include` glob and
// ambient .d.ts files are never pulled in by the import graph, only by
// `include` — so the e2e program needs its own copy of the same shim.
declare module '*?worker' {
  const workerConstructor: new (options?: { name?: string }) => Worker
  export default workerConstructor
}
