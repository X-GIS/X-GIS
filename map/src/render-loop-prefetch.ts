// ═══ Frame-scope anticipatory prefetch — the ordering, in one place (#1587) ═══
//
// Both prefetch routes — AMMOS 3D-Tiles-Renderer-style `loadSiblings` and Google-Earth-style
// pan-direction speculation — had, as far as any static read shows, NEVER run in the product.
// Not degraded: never entered. `VectorTileRenderer.beginFrame` calls `_selection.invalidateFrame()`,
// and the pump was called sixteen lines later in the same straight-line block, reading the very
// cache that clear had just emptied. `pumpPrefetch`'s `if (!cache) return` therefore fired on
// EVERY frame, for every source, with no branch in between to escape through.
//
// ── WHY THE PUMP MOVED RATHER THAN THE CLEAR ──────────────────────────────────────────────────
//
// The call site's own comment states why the pump lives in the frame function at all: it must fire
// "exactly once per wall-clock frame", NOT inside `VTR.render`, which the bucket scheduler invokes
// per ShowCommand (~80× on dense styles) — re-firing there would flood `_evictShield`, race visible
// tiles for the catalog's concurrency budget, and corrupt the velocity vector route 2 measures.
//
// That reason is about FREQUENCY, not position. Moving the pump later inside the same frame
// function satisfies it exactly as the original placement did, while giving it the one thing it
// always needed: a populated selection. The alternative — having `invalidateFrame` retain the
// outgoing entry — would change a lifetime contract four other readers share, to buy nothing this
// does not. (The clear is documented in `tile-selection-cache.ts` as a GC hint that is not required
// for correctness, so that option was cheap; it was simply not necessary.)
//
// ── WHAT THIS CHANGES SEMANTICALLY ────────────────────────────────────────────────────────────
//
// The pump now reads the selection the frame just computed and prefetches for the NEXT frame. That
// is what "anticipatory" was always supposed to mean; before, it read a selection that did not
// exist yet and did nothing at all.
//
// ── ONE HELPER, TWO ARMS ──────────────────────────────────────────────────────────────────────
//
// The WebGPU frame and the WebGL2 twin frame are separate full-frame paths, and both are
// interactive. Inlining the loop in each would make "when does the pump fire" two authorities that
// can drift — the sibling-drift failure this repo's audits name as their most productive lens. The
// pick pass is deliberately NOT a caller: see `skipPrefetchForPickPass` below.

import type { Camera } from './camera'

/** The slice of a vector-tile renderer this pump drives. */
export interface PrefetchPumpTarget {
  pumpPrefetch(
    camera: Camera,
    projType: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void
}

/** The frame host this reads: its attached sources and the camera route 2 measures. */
export interface PrefetchPumpHost {
  vtSources: Iterable<[unknown, { renderer: PrefetchPumpTarget }]>
  camera: Camera
}

/** Run the anticipatory prefetch for every attached vector source, once.
 *
 *  MUST be called AFTER the frame's draw passes have run, because those are what populate each
 *  renderer's frame tile selection (`selectForFrame`). Called before them — which is where it used
 *  to live — every source reads an empty selection and returns immediately. Nothing in here can
 *  enforce that ordering, which is exactly why the ordering has a TEST of its own rather than a
 *  comment of its own: a comment is what this defect hid behind for its whole life.
 *
 *  `projType` is the render-loop's camera-resolved value, not the opaque ctx.projection token. */
export function pumpFramePrefetch(
  host: PrefetchPumpHost,
  projType: number,
  scene: { w: number; h: number; dpr: number },
): void {
  for (const [, { renderer }] of host.vtSources) {
    renderer.pumpPrefetch(host.camera, projType, scene.w, scene.h, scene.dpr)
  }
}

/** Why the pick pass does not pump, recorded where someone adding a third caller will look.
 *
 *  `pickViaRhi` renders an offscreen rg32uint attachment to answer a hit test. It is not a display
 *  frame and it runs at whatever cadence the host asks questions — a hover handler can fire it many
 *  times between two painted frames, or not at all for minutes. Pumping there would sample the
 *  velocity vector over a dt that has nothing to do with the camera's motion on screen, and would
 *  double-pump any frame that also happened to service a pick. The route-2 speculation depends on
 *  that dt being a real one-frame measurement.
 *
 *  Exported as a documented constant rather than a bare comment so it survives a file reshuffle. */
export const skipPrefetchForPickPass = true
