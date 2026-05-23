import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'

// ═══ CHARACTERIZATION — per-frame render path ═══════════════════════
//
// Safety net BEFORE an upcoming structural decoupling of XGISMap. These
// tests PIN the CURRENT observable behaviour of the per-frame render
// decision path — `shouldRenderThisFrame()`, `hasPendingSourceWork()`,
// and the synchronous stats / dump / inspect accessors that report what
// a frame produced. They are NOT correctness tests: every assertion
// captures what the code does TODAY so a later refactor can prove it
// unchanged. If a value here looks "wrong", do not fix it here — change
// it deliberately in map.ts and update the pin with a note.
//
// WHY no real renderFrame() drive: `renderFrame()` (and the `run()` path
// that populates `vtSources`) require a live WebGPU device — the same
// reason map-fit-zoom.test.ts and map-epsg-ingest-reprojection.test.ts
// drive underscore test-seams instead of full frames. We deliberately
// avoid timed render loops / wall-clock convergence (the source of the
// flaky tile-pitch-throughput spec). Everything below is synchronous and
// device-free, so it is bit-deterministic across runs.
//
// What IS observable without a GPU on a fresh XGISMap:
//   - `shouldRenderThisFrame()` — pure decision over private dirty flags
//     + camera/canvas signature (private; reached via the same cast seam
//     the EPSG spec uses).
//   - `hasPendingSourceWork()`   — iterates `vtSources` (empty pre-run()).
//   - `invalidate()` / `_needsRender` — the explicit dirty trigger.
//   - `stats` (RenderStats getter) — StatsTracker initial snapshot.
//   - `getDumpedLabels()` / `getDumpedIcons()` — null until a TextStage /
//     IconStage exists (post-GPU-init only).
//   - `inspectPipeline()` — camera-derived snapshot + empty source list.
//   - `getLayoutCacheStats()` — null until TextStage exists.

function mockCanvas(width = 1200, height = 800): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement
}

/** Private render-path seam. `shouldRenderThisFrame` /
 *  `hasPendingSourceWork` are `private`; the EPSG + fit-zoom specs
 *  establish this single-cast access pattern for CPU-only proofs. The
 *  signature fields (`_lastSig*`) and `_needsRender` are read to
 *  characterise the idle-skip comparator's exact inputs. */
interface RenderPathSeam {
  shouldRenderThisFrame(): boolean
  hasPendingSourceWork(): boolean
  _needsRender: boolean
  _sceneHasAnimation: boolean
  _lastSigZoom: number
  _lastSigCX: number
  _lastSigCY: number
  _lastSigBearing: number
  _lastSigPitch: number
  _lastSigW: number
  _lastSigH: number
  vtSources: Map<string, unknown>
  ctx?: { canvas: HTMLCanvasElement }
  camera: {
    zoom: number
    centerX: number
    centerY: number
    bearing: number
    pitch: number
  }
}

function seam(map: XGISMap): RenderPathSeam {
  return map as unknown as RenderPathSeam
}

/** Drive the map into the "settled / idle" state the way `renderFrame()`
 *  does at its tail (lines ~5235): copy the live camera + canvas into the
 *  last-signature fields and clear `_needsRender`. This is the ONLY way
 *  to exercise the idle-skip branch of `shouldRenderThisFrame()` without
 *  a GPU frame, and it must mirror EXACTLY what the comparator reads.
 *
 *  CHARACTERIZATION FINDING (pinned by the "no ctx" tests below): the
 *  comparator reads canvas size from `this.ctx?.canvas` — NOT from the
 *  construction canvas. Pre-run() `ctx` is undefined, so the live W/H the
 *  comparator sees collapse to 0 via `?? 0`. Settling must therefore use
 *  the SAME `ctx?.canvas ?? 0` resolution, otherwise the settled W/H
 *  (e.g. 1200) will never equal the comparator's 0 and the scene can
 *  never idle-skip. We replicate the comparator's exact read so the
 *  clean-skip state is reachable in the GPU-free test env. */
function settleSignature(map: XGISMap): void {
  const s = seam(map)
  const liveCanvas = s.ctx?.canvas
  s._lastSigZoom = s.camera.zoom
  s._lastSigCX = s.camera.centerX
  s._lastSigCY = s.camera.centerY
  s._lastSigBearing = s.camera.bearing
  s._lastSigPitch = s.camera.pitch
  s._lastSigW = liveCanvas?.width ?? 0
  s._lastSigH = liveCanvas?.height ?? 0
  s._needsRender = false
}

describe('XGISMap render-path characterization — fresh-construct invariants', () => {
  it('a fresh map reports _needsRender=true and shouldRenderThisFrame()=true', () => {
    // PIN: the constructor leaves `_needsRender = true` so the very first
    // rAF tick always draws (no first-frame skip).
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    expect(s._needsRender).toBe(true)
    expect(s._sceneHasAnimation).toBe(false)
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a fresh map has an empty vtSources and hasPendingSourceWork()=false', () => {
    // PIN: `vtSources` is populated only by run() (needs a GPU device).
    // With none registered, the pending-work scan finds nothing.
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    expect(s.vtSources.size).toBe(0)
    expect(s.hasPendingSourceWork()).toBe(false)
  })

  it('the last-signature fields start as NaN (zoom/center/bearing/pitch) and 0 (w/h)', () => {
    // PIN: the idle-skip comparator's "never drawn" sentinel. NaN !==
    // anything, so any finite camera value differs → render forced until
    // the first settle. Width/height start 0.
    const s = seam(new XGISMap(mockCanvas()))
    expect(Number.isNaN(s._lastSigZoom)).toBe(true)
    expect(Number.isNaN(s._lastSigCX)).toBe(true)
    expect(Number.isNaN(s._lastSigCY)).toBe(true)
    expect(Number.isNaN(s._lastSigBearing)).toBe(true)
    expect(Number.isNaN(s._lastSigPitch)).toBe(true)
    expect(s._lastSigW).toBe(0)
    expect(s._lastSigH).toBe(0)
  })

  it('the constructor camera is lon=0 lat=20 zoom=2 (Camera(0,20,2))', () => {
    // PIN: characterizes the default scene the render path sees. zoom is
    // exactly 2; centerX is exactly 0 (lon 0 → mercator x 0); centerY is
    // the mercator-Y of lat 20 (positive, north of equator). bearing /
    // pitch default to 0 — the "flat mercator" baseline.
    const s = seam(new XGISMap(mockCanvas()))
    expect(s.camera.zoom).toBe(2)
    expect(s.camera.centerX).toBe(0)
    expect(s.camera.centerY).toBeGreaterThan(0)
    expect(s.camera.bearing).toBe(0)
    expect(s.camera.pitch).toBe(0)
  })
})

describe('XGISMap render-path characterization — shouldRenderThisFrame() decision matrix', () => {
  it('returns false once settled with a clean signature (idle-skip engaged)', () => {
    // PIN: the whole point of the idle-skip — after a settle with no
    // dirty flags, no animation, and no pending source work, a static
    // scene skips the frame.
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    expect(s.shouldRenderThisFrame()).toBe(false)
  })

  it('_needsRender=true always forces a render (highest-priority short-circuit)', () => {
    // PIN: order matters — `_needsRender` is checked first, before
    // animation / pending-work / signature. invalidate() re-arms it.
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    settleSignature(map)
    expect(seam(map).shouldRenderThisFrame()).toBe(false)
    map.invalidate()
    expect(seam(map).shouldRenderThisFrame()).toBe(true)
  })

  it('_sceneHasAnimation=true forces a render even with a clean signature', () => {
    // PIN: the second short-circuit. Animated scenes never idle-skip.
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    expect(s.shouldRenderThisFrame()).toBe(false)
    s._sceneHasAnimation = true
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a zoom change re-dirties the signature → render (camera-input resume)', () => {
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    expect(s.shouldRenderThisFrame()).toBe(false)
    s.camera.zoom = s.camera.zoom + 1
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a bearing change re-dirties the signature → render', () => {
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    s.camera.bearing = 45
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a pitch change re-dirties the signature → render (pitched scene)', () => {
    // PIN: pitch participates in the signature, so tilting resumes
    // per-frame rendering. (Camera.pitch is unlocked at projType 0.)
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    s.camera.pitch = 60
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a centerX (pan) change re-dirties the signature → render', () => {
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    s.camera.centerX = s.camera.centerX + 1000
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a centerY (pan) change re-dirties the signature → render', () => {
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    s.camera.centerY = s.camera.centerY + 1000
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a canvas resize (width) re-dirties the signature → render', () => {
    // PIN: canvas width/height participate in the signature, so a resize
    // resumes per-frame rendering. The comparator reads `this.ctx?.canvas`
    // (NOT the construction canvas) — so to exercise the resize path in a
    // GPU-free test we inject a stub ctx, settle against it, then mutate
    // its canvas width. This is the only way to characterize the W/H
    // signal positively without a real GPU device.
    const liveCanvas = mockCanvas(1200, 800)
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.ctx = { canvas: liveCanvas }
    settleSignature(map)
    expect(s.shouldRenderThisFrame()).toBe(false)
    liveCanvas.width = 1400
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('a canvas resize (height) re-dirties the signature → render', () => {
    const liveCanvas = mockCanvas(1200, 800)
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.ctx = { canvas: liveCanvas }
    settleSignature(map)
    expect(s.shouldRenderThisFrame()).toBe(false)
    liveCanvas.height = 900
    expect(s.shouldRenderThisFrame()).toBe(true)
  })

  it('with no ctx, the canvas signature reads 0×0 (documents the ?? 0 fallback)', () => {
    // PIN: shouldRenderThisFrame uses `this.ctx?.canvas` — without GPU
    // init `ctx` is undefined so w/h collapse to 0. We settle the sig to
    // the actual 0×0 the comparator will read, proving the clean-skip
    // still works when ctx is absent.
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    // Settle camera AND force the W/H sig to the no-ctx values (0,0).
    s._lastSigZoom = s.camera.zoom
    s._lastSigCX = s.camera.centerX
    s._lastSigCY = s.camera.centerY
    s._lastSigBearing = s.camera.bearing
    s._lastSigPitch = s.camera.pitch
    s._lastSigW = 0
    s._lastSigH = 0
    s._needsRender = false
    expect(s.ctx).toBeUndefined()
    expect(s.shouldRenderThisFrame()).toBe(false)
  })
})

describe('XGISMap render-path characterization — hasPendingSourceWork() over vtSources', () => {
  it('empty scene (no sources) → false', () => {
    const map = new XGISMap(mockCanvas())
    expect(seam(map).hasPendingSourceWork()).toBe(false)
  })

  it('a source with pending HTTP loads → true (first signal, highest priority)', () => {
    // PIN: the scan returns true on the FIRST positive signal in cost
    // order: hasPendingLoads → hasPendingUploads → missedTiles. A stub
    // source whose only positive signal is hasPendingLoads must trip it.
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('pending-fetch', {
      source: { hasPendingLoads: () => true },
      renderer: { hasPendingUploads: () => false, getDrawStats: () => ({ missedTiles: 0 }) },
    })
    expect(s.hasPendingSourceWork()).toBe(true)
  })

  it('a source with pending GPU uploads → true (second signal)', () => {
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('pending-upload', {
      source: { hasPendingLoads: () => false },
      renderer: { hasPendingUploads: () => true, getDrawStats: () => ({ missedTiles: 0 }) },
    })
    expect(s.hasPendingSourceWork()).toBe(true)
  })

  it('a source with missedTiles>0 last frame → true (third signal)', () => {
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('missed', {
      source: { hasPendingLoads: () => false },
      renderer: { hasPendingUploads: () => false, getDrawStats: () => ({ missedTiles: 3 }) },
    })
    expect(s.hasPendingSourceWork()).toBe(true)
  })

  it('a fully-loaded source (no fetch, no upload, no misses) → false', () => {
    // PIN: the converged steady state — a source that has finished all
    // its work contributes nothing, so an otherwise-idle scene skips.
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('loaded', {
      source: { hasPendingLoads: () => false },
      renderer: { hasPendingUploads: () => false, getDrawStats: () => ({ missedTiles: 0 }) },
    })
    expect(s.hasPendingSourceWork()).toBe(false)
  })

  it('missing optional accessors are treated as no-work (?. guards) → false', () => {
    // PIN: every signal is read through optional chaining
    // (`source.hasPendingLoads?.()`, `renderer.getDrawStats?.()`), so a
    // source missing those methods entirely is benign, not a throw.
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('bare', { source: {}, renderer: {} })
    expect(s.hasPendingSourceWork()).toBe(false)
  })

  it('getDrawStats() returning undefined missedTiles → false (nullish guard)', () => {
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('no-missed-field', {
      source: { hasPendingLoads: () => false },
      renderer: { hasPendingUploads: () => false, getDrawStats: () => ({}) },
    })
    expect(s.hasPendingSourceWork()).toBe(false)
  })

  it('pending source work makes shouldRenderThisFrame()=true even when settled', () => {
    // PIN: the integration of the two functions — `shouldRenderThisFrame`
    // calls `hasPendingSourceWork()` as its third short-circuit, so a
    // settled/clean camera still renders while a source has work.
    const canvas = mockCanvas()
    const map = new XGISMap(canvas)
    const s = seam(map)
    settleSignature(map)
    expect(s.shouldRenderThisFrame()).toBe(false)
    s.vtSources.set('pending', {
      source: { hasPendingLoads: () => true },
      renderer: { hasPendingUploads: () => false, getDrawStats: () => ({ missedTiles: 0 }) },
    })
    expect(s.shouldRenderThisFrame()).toBe(true)
  })
})

describe('XGISMap render-path characterization — stats / dump accessors (pre-frame)', () => {
  it('stats getter returns an all-zero RenderStats with bundleHitRate=0 before any frame', () => {
    // PIN: the initial StatsTracker snapshot. drawCalls / vertices /
    // triangles / lines / tilesVisible / tilesCached are all 0; zoom is
    // the tracker's own 0 (NOT the camera's — stats.zoom is only synced
    // inside renderFrame); bundleHitRate is 0 when total==0.
    const map = new XGISMap(mockCanvas())
    const st = map.stats
    expect(st.drawCalls).toBe(0)
    expect(st.vertices).toBe(0)
    expect(st.triangles).toBe(0)
    expect(st.lines).toBe(0)
    expect(st.tilesVisible).toBe(0)
    expect(st.tilesCached).toBe(0)
    expect(st.tilesLoaded).toBe(0)
    expect(st.gpuBuffers).toBe(0)
    expect(st.zoom).toBe(0)
    expect(st.bundleHits).toBe(0)
    expect(st.bundleMisses).toBe(0)
    expect(st.bundleHitRate).toBe(0)
    expect(st.bundleEvictions).toBe(0)
    expect(st.bundleReplaysThisFrame).toBe(0)
  })

  it('stats.heapDeltaBytes is the -1 sentinel before any endFrame()', () => {
    // PIN: heapDeltaBytes starts at -1 (StatsTracker init) and is only
    // updated inside endFrame() (called at the renderFrame tail). With no
    // frame driven it stays at the sentinel regardless of platform.
    expect(new XGISMap(mockCanvas()).stats.heapDeltaBytes).toBe(-1)
    expect(new XGISMap(mockCanvas()).stats.heapDeltaAvgBytes).toBe(0)
  })

  it('getDumpedLabels() is null before a TextStage exists (no GPU init)', () => {
    // PIN: the dump accessor is lazy on textStage, which is built during
    // GPU init. Pre-run() it is null — not [] — so consumers must
    // null-check.
    expect(new XGISMap(mockCanvas()).getDumpedLabels()).toBeNull()
  })

  it('getDumpedIcons() is null before an IconStage exists (no GPU init)', () => {
    expect(new XGISMap(mockCanvas()).getDumpedIcons()).toBeNull()
  })

  it('getLayoutCacheStats() is null before a TextStage exists', () => {
    expect(new XGISMap(mockCanvas()).getLayoutCacheStats()).toBeNull()
  })
})

describe('XGISMap render-path characterization — inspectPipeline() snapshot (sync, GPU-free)', () => {
  it('reports the default camera (lon≈0, lat≈20, zoom=2, bearing=0, pitch=0)', () => {
    // PIN: inspectPipeline derives lon/lat back from mercator centerX/Y.
    // The default Camera(0,20,2) round-trips to lon 0, lat 20.
    const insp = new XGISMap(mockCanvas()).inspectPipeline()
    expect(insp.camera.zoom).toBe(2)
    expect(insp.camera.lon).toBeCloseTo(0, 6)
    expect(insp.camera.lat).toBeCloseTo(20, 6)
    expect(insp.camera.bearing).toBe(0)
    expect(insp.camera.pitch).toBe(0)
    expect(insp.camera.maxZoom).toBe(22)
  })

  it('reports the construction-canvas viewport with dpr=1 in the node test env', () => {
    // PIN: with no ctx (GPU) the viewport reads 0×0 — inspectMapPipeline
    // uses `m.ctx?.canvas.width ?? 0`, and ctx is undefined pre-run().
    // dpr is 1 because `typeof window === 'undefined'` under vitest's
    // default node environment (the window branch never runs).
    const insp = new XGISMap(mockCanvas(1200, 800)).inspectPipeline()
    expect(insp.viewport.canvasW).toBe(0)
    expect(insp.viewport.canvasH).toBe(0)
    expect(insp.viewport.dpr).toBe(1)
  })

  it('reports frame=0, no explicit camera positioning, empty sources, no flickers', () => {
    // PIN: a fresh map has driven zero frames, has not had its camera
    // explicitly positioned (post-compile bounds-fit still allowed), has
    // no registered sources, and an empty FLICKER ring.
    const insp = new XGISMap(mockCanvas()).inspectPipeline()
    expect(insp.frame).toBe(0)
    expect(insp.cameraExplicitlyPositioned).toBe(false)
    expect(insp.sources).toEqual([])
    expect(insp.recentFlickers).toEqual([])
  })

  it('recentFlickers is a COPY of the internal ring (mutation isolation)', () => {
    // PIN: inspectPipeline spreads `[...m._flickerLog]`, so a caller
    // mutating the returned array cannot corrupt internal state.
    const map = new XGISMap(mockCanvas())
    const a = map.inspectPipeline().recentFlickers
    a.push({ ts: 1, source: 'x', missed: 1, z: 1, cache: 1 })
    expect(map.inspectPipeline().recentFlickers).toEqual([])
  })

  it('reflects a registered source: name, overzoom math, and frame draw stats', () => {
    // PIN: with a stub source registered, inspectPipeline surfaces its
    // name, computes overzoomLevels = max(0, round(zoom) - maxLevel), and
    // copies the renderer's getDrawStats() into frame.*. At default
    // zoom=2 over a maxLevel-14 source, overzoom is 0.
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.vtSources.set('demo', {
      source: {
        maxLevel: 14,
        getPendingLoadCount: () => 0,
        hasData: () => true,
        getSubTileBudgetUsed: () => 0,
        getCompileBudgetUsed: () => 0,
      },
      renderer: {
        getDrawStats: () => ({ drawCalls: 7, tilesVisible: 5, missedTiles: 0, triangles: 120, lines: 30 }),
        getCacheSize: () => 4,
        getPendingUploadCount: () => 0,
      },
    })
    const insp = map.inspectPipeline()
    expect(insp.sources).toHaveLength(1)
    const src = insp.sources[0]!
    expect(src.name).toBe('demo')
    expect(src.sourceMaxLevel).toBe(14)
    expect(src.currentZoomRounded).toBe(2)
    expect(src.overzoomLevels).toBe(0)
    expect(src.cache.size).toBe(4)
    expect(src.cache.hasData).toBe(true)
    expect(src.frame).toEqual({ drawCalls: 7, tilesVisible: 5, missedTiles: 0, triangles: 120, lines: 30 })
  })
})
