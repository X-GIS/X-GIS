// ═══ Bucket 1: opaque pass ═══
//
// Relocated VERBATIM from RenderLoop.render's opaque bucket loop. Emits
// one or more same-source sub-passes: the first clears the colour target
// and owns the raster + canvas-2D background + legacy MapRenderer draws;
// each sub-pass renders its group's vector-tile shows in two phases (2D
// ground fills, then 3D extruded fills) so cross-tile depth ordering is
// correct at high pitch regardless of declaration order. Depth persists
// across sub-passes (and into OIT / points) so later groups occlude
// against earlier ones.
//
// Mechanical changes only: `this.host.X` → `host.X`, `encoder` →
// `ctx.encoder`. All loop-local state stays inside execute(); behaviour is
// byte-identical to the inline block.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import { isPickEnabled } from '../../gpu/gpu'
import { resolveNumberShape } from '../paint-shape-resolve'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderPass, OpaquePassHost } from './pass'

class OpaquePass implements RenderPass {
  readonly label = 'opaque'

  // PoC US-S3 — baked tile texture + its geo bounds, cached across frames so
  // the bake runs ONCE (not every frame). Only populated behind
  // `globalThis.__xgisDebugBakeDrape`. See .omc/progress.txt.
  private _bakeDrapeTex: GPUTexture | null = null
  private _bakeDrapeBounds: { west: number; south: number; east: number; north: number } | null = null

  // PoC multi-tile drape — one baked texture per resident tile key, baked once
  // and reused across frames. Only populated behind `__xgisDebugMultiDrape`.
  private _multiDrapeTex = new Map<string, GPUTexture>()

  // ISOLATION: ONE tile baked once + frozen, drawn via drawDrape OR the surface
  // quadtree (same tile, same bake) so the two paths are compared with zero
  // tile-set / timing confound. Behind __xgisDebugIso.
  private _isoTile: { tex: GPUTexture; west: number; south: number; east: number; north: number; z: number } | null = null

  // Always emits at least the synthetic first sub-pass (raster + canvas
  // background + screen clear), even with no opaque vector layers.
  shouldRun(): boolean { return true }

  execute(ctx: FrameContext, scene: SceneView, host: OpaquePassHost): void {
    const encoder = ctx.encoder
    // ── Bucket 1: opaque ──
    // Always emit at least one pass so raster + canvas background
    // can run even if there are no vector layers to draw. The first
    // pass clears the color target; subsequent opaque sub-passes
    // load.
    const opaqueCount = Math.max(1, scene.opaqueGroups.length)
    for (let gi = 0; gi < opaqueCount; gi++) {
      const group = scene.opaqueGroups[gi]
      const isFirst = gi === 0
      const isLastOpaque = gi === opaqueCount - 1
      // Only the LAST opaque sub-pass can claim resolveTarget, and
      // only if no translucent/points pass runs after it.
      const resolveHere =
        ctx.useResolve && isLastOpaque && scene.resolveOwner === 'opaque'
      // Depth must persist across opaque sub-passes so group N's
      // polygons are correctly occluded by group N-1's (e.g. roads
      // rendered after buildings must respect building depth in a
      // pitched / globe view), and across into the points bucket for
      // the same reason. Only the final consumer can discard. Tile-
      // based mobile GPUs pay a write-back when we store, but the
      // result was visibly wrong without it.
      // OIT pass needs the opaque depth to occlude translucent
      // fragments behind opaque foreground walls; bucket 3 (points)
      // also reads it. Either consumer requires the LAST opaque
      // sub-pass to STORE depth instead of discarding.
      const persistDepth = !isLastOpaque || scene.hasPoints || scene.hasOit

      ctx.passScope(isFirst ? 'opaque-main' : `opaque[${gi}]`, () => {
        // Time EVERY opaque sub-pass. The timer pre-allocates a
        // QuerySet wide enough for MAX_SUBPASSES sub-passes, with
        // sub-pass 0 carrying the inside-passes breakdown (bg/raster/
        // legacy/vt) and sub-passes 1..N each contributing one
        // (begin..end) duration that aggregates into the `vt` ring.
        // Demos like osm_style split opaque rendering across multiple
        // groups; single-pass timing missed everything past the first.
        const tsWrites = host.gpuTimer?.passWrites() || undefined
        // Build color attachments. When picking is enabled, add a
        // second RG32Uint attachment at location 1 — every pipeline
        // in the main passes has a matching second fragment output
        // that writes `vec2<u32>(feature_id, instance_id)`. The first
        // sub-pass clears the pick texture to (0, 0) = "no feature";
        // subsequent sub-passes load so earlier-group IDs persist
        // where later groups didn't draw.
        const colorAttachments: GPURenderPassColorAttachment[] = [{
          view: ctx.colorView,
          resolveTarget: resolveHere ? ctx.screenView : undefined,
          // The colour target is cleared by the background pass (bucket 0,
          // render/passes/background-pass.ts) which now owns the
          // whole-viewport clear — the coverage seam from VISION §5 gap #1.
          // Every opaque sub-pass therefore LOADs the colour it left. The
          // inside-band style `background-color` is still painted by the
          // synthetic earth-surface ShowCommand through this same pipeline;
          // the outside-band region is whatever the background pass cleared.
          // (Depth / stencil / pick are still cleared by THIS first
          // sub-pass below — they are bucket-1 concerns, not coverage.)
          loadOp: 'load',
          storeOp: 'store',
        }]
        if (isPickEnabled() && ctx.rt.pickTexture) {
          colorAttachments.push({
            view: ctx.rt.pickTexture.createView(),
            clearValue: isFirst ? { r: 0, g: 0, b: 0, a: 0 } : undefined,
            loadOp: isFirst ? 'clear' : 'load',
            storeOp: 'store',
          })
        }
        const subPass = encoder.beginRenderPass({
          colorAttachments,
          depthStencilAttachment: {
            view: ctx.rt.stencilTexture!.createView(),
            depthClearValue: 1.0,
            // First sub-pass clears depth; subsequent ones load the
            // depth their predecessor stored.
            depthLoadOp: isFirst ? 'clear' : 'load',
            depthStoreOp: persistDepth ? 'store' : 'discard',
            // Stencil IS still per-sub-pass — each opaque group uses
            // unique IDs for its own polygon coverage and they don't
            // need to survive across groups.
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
          },
          timestampWrites: tsWrites,
        })

        // First opaque pass owns raster + canvas-2D background
        // content. These are always the back-most layers in the
        // current architecture. Phase 2 PR 2c.3 retired the
        // BackgroundRenderer call site — the style background fill
        // is now dispatched via the synthetic earth-surface
        // ShowCommand prepended to commands.shows in XGISMap.run().
        if (isFirst) {
          host.gpuTimer?.mark(subPass, 'after_bg')
          // Per-frame raster-opacity resolve. resolveNumberShape
          // honours constant / zoom-interpolated / time-interpolated
          // / zoom-time shapes — same code that drives every other
          // layer's opacity, just driving the global raster
          // renderer's uniform.
          if (host._rasterShow) {
            const z = host.camera.zoom
            const ms = host._elapsedMs
            const rs = host._rasterShow.paintShapes.raster
            host.rasterRenderer.setOpacity(
              resolveNumberShape(host._rasterShow.paintShapes.common.opacity, z, ms).value,
            )
            // raster-* colour adjustments — resolved through the same
            // PropertyShape path as opacity (constant today; zoom/time
            // shapes resolve transparently if ever plumbed).
            host.rasterRenderer.setColorAdjust(
              resolveNumberShape(rs.hueRotate, z, ms).value,
              resolveNumberShape(rs.brightnessMin, z, ms).value,
              resolveNumberShape(rs.brightnessMax, z, ms).value,
              resolveNumberShape(rs.saturation, z, ms).value,
              resolveNumberShape(rs.contrast, z, ms).value,
            )
            host.rasterRenderer.setResampling(rs.resamplingNearest)
          } else {
            host.rasterRenderer.setOpacity(1)
            host.rasterRenderer.setColorAdjust(0, 0, 1, 0, 0)
            host.rasterRenderer.setResampling(false)
          }
          host.rasterRenderer.render(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr)
          // PoC S1 (approach B): debug-flag-gated globe texture-drape proof.
          if ((globalThis as { __xgisDebugDrape?: boolean }).__xgisDebugDrape) {
            host.rasterRenderer.drawDrape(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr)
          }
          // PoC S2+S3: bake ONE cached vector tile to a texture, then drape it
          // over the tile's TRUE geo extent. Bake once + cache across frames.
          if ((globalThis as { __xgisDebugBakeDrape?: boolean }).__xgisDebugBakeDrape) {
            if (!this._bakeDrapeTex) {
              for (const { renderer: vtr } of host.vtSources.values()) {
                const pick = vtr.firstNonEmptyCachedTile(ctx.centerLon, ctx.centerLat)
                if (!pick) continue
                // Composite ALL layers at the picked z/x/y so the bake shows the
                // full map tile (bold), not one sparse layer.
                const tex = vtr.bakeTileToTexture(vtr.cachedLayersAt(pick.z, pick.x, pick.y), pick.z, 512)
                if (!tex) continue
                // Tile geo bounds from z/x/y (standard slippy formula;
                // mirrors raster-renderer.ts:407-414).
                const n = Math.pow(2, pick.z)
                const west = (pick.x / n) * 360 - 180
                const east = ((pick.x + 1) / n) * 360 - 180
                const north = (Math.atan(Math.sinh(Math.PI * (1 - 2 * pick.y / n))) * 180) / Math.PI
                const south = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (pick.y + 1) / n))) * 180) / Math.PI
                this._bakeDrapeTex = tex
                this._bakeDrapeBounds = { west, south, east, north }
                console.warn(`[BAKEDRAPE] baked z${pick.z}/${pick.x}/${pick.y} bounds W${west.toFixed(1)} S${south.toFixed(1)} E${east.toFixed(1)} N${north.toFixed(1)}`)
                break
              }
            }
            // The drawDrape call is emitted AFTER the vector tile shows below
            // (PoC: approach B replaces fills with the drape, so it must paint
            // ON TOP, not get covered by the same source's vector fills).
          }
          host.gpuTimer?.mark(subPass, 'after_raster')
          host.renderer.renderToPass(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, host._elapsedMs)
          host.gpuTimer?.mark(subPass, 'after_legacy')
        }

        // Render the group's vector tile shows (if any). Two-phase
        // within the same sub-pass:
        //   Phase 1: 2D ground shows (extrude.kind === 'none' or
        //            absent) — depth-disabled fill, painter's order
        //            decided by GPU command order.
        //   Phase 2: 3D extruded shows (extrude.kind !== 'none')
        //            — depth-write enabled, cross-tile occlusion
        //            resolves via depth-test against a depth
        //            attachment that's CLEAN at the start of phase 2
        //            (phase 1 didn't write depth). This is the
        //            architectural separation 3D rendering needs:
        //            RT-painted ground is conceptually a backdrop
        //            for the 3D world, and mixing them in arbitrary
        //            declaration order breaks cross-tile depth
        //            ordering at high pitch (back-tile buildings
        //            poking through closer-tile buildings) when a
        //            ground show happens to land between two
        //            extruded shows in the same group. Two-phase
        //            ordering within the group enforces the
        //            invariant regardless of declaration order.
        //
        // In a points-only demo (no opaque vector tile layers at
        // all) `group` is undefined and the synthetic first pass
        // exists only to clear the canvas + draw raster + draw
        // legacy MapRenderer layers. We MUST still call
        // subPass.end() in that case, otherwise the pass stays
        // open and bucket 3 (or any subsequent encoder operation)
        // trips a "RenderPassEncoder is open" validation error.
        if (group) {
          const isExtruded = (cs: typeof group.shows[number]): boolean => {
            const ex = (cs.show as { extrude?: { kind?: string } }).extrude
            return !!ex && ex.kind !== undefined && ex.kind !== 'none'
          }
          // Debug=overdraw: collapse every fill variant onto the
          // single fill debug pipeline whose bgl matches the show's.
          // VTR's setPipeline calls use it uniformly — fallback /
          // ground / extruded variants all output the same constant
          // fragment count. Line pipeline is unused inside VTR's
          // debug path (strokes route through LineRenderer which is
          // gated off too), but we still pass a non-null override
          // for completeness.
          const drawShow = (cs: typeof group.shows[number]) => {
            const debugFp = DEBUG_OVERDRAW
              ? (cs.bgl === host.renderer.featureBindGroupLayout
                  ? host.renderer.fillPipelineOverdrawFeature!
                  : host.renderer.fillPipelineOverdraw!)
              : null
            const debugLp = DEBUG_OVERDRAW ? host.renderer.linePipelineOverdraw! : null
            const fp = debugFp ?? cs.fp
            const lp = debugLp ?? cs.lp
            const fpF = debugFp ?? cs.fpF
            const lpF = debugLp ?? cs.lpF
            const fpG = debugFp ?? cs.fpG
            const fpGF = debugFp ?? cs.fpGF
            cs.vtEntry.renderer.render!(
              subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h,
              cs.show, fp, lp, host.renderer.uniformBuffer, cs.bgl,
              fpF, lpF,
              DEBUG_OVERDRAW ? null : host.pointRenderer,
              cs.fillPhase,
              ctx.dpr,
              fpG, fpGF,
              false, cs.resolvedShow,
            )
          }
          for (let si = 0; si < group.shows.length; si++) {
            if (!isExtruded(group.shows[si])) drawShow(group.shows[si])
          }
          for (let si = 0; si < group.shows.length; si++) {
            if (isExtruded(group.shows[si])) drawShow(group.shows[si])
          }
        }

        // PoC S2+S3: paint the baked-tile drape ON TOP of the vector fills (only
        // the first sub-pass; gated). approach B's end state replaces the fills.
        if (isFirst && (globalThis as { __xgisDebugBakeDrape?: boolean }).__xgisDebugBakeDrape
            && this._bakeDrapeTex && this._bakeDrapeBounds) {
          // Probe: __xgisDrapeCheckerBounds drapes the OPAQUE checkerboard (texture
          // = undefined) over the SAME bounds, to isolate bounds-projection from
          // texture-alpha. If the checker rectangle warps onto the globe at the
          // tile region, projection is fine and the green-loss is texture/alpha.
          const useChecker = (globalThis as { __xgisDrapeCheckerBounds?: boolean }).__xgisDrapeCheckerBounds
          host.rasterRenderer.drawDrape(
            subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr,
            useChecker ? undefined : this._bakeDrapeTex, this._bakeDrapeBounds,
          )
        }

        // PoC multi-tile drape (approach B integration): bake EVERY resident
        // vector tile to a texture (once, cached per key) and drape each over its
        // true geo bounds — the real approach-B path replacing the direct vector
        // draw on the globe. Gated on __xgisDebugMultiDrape; inert when off.
        if (isFirst && (globalThis as { __xgisDebugMultiDrape?: boolean }).__xgisDebugMultiDrape) {
          // One-shot cache clear → re-bake every resident tile from its CURRENT
          // (fully-loaded) data, so stale sparse bakes (baked mid-load) are dropped.
          const gt = globalThis as { __xgisClearMultiDrapeCache?: boolean }
          if (gt.__xgisClearMultiDrapeCache) {
            for (const t of this._multiDrapeTex.values()) t.destroy()
            this._multiDrapeTex.clear()
            gt.__xgisClearMultiDrapeCache = false
          }
          const mdCurZoom = host.camera.zoom
          const mdBakeSize = (tileZoom: number) =>
            Math.min(1024, Math.max(256, Math.round(256 * Math.pow(2, Math.max(0, mdCurZoom - tileZoom)))))
          for (const { renderer: vtr } of host.vtSources.values()) {
            for (const k of vtr.residentTileKeys()) {
              const sz = mdBakeSize(k.z)
              const id = `${k.z}/${k.x}/${k.y}@${sz}`
              let tex = this._multiDrapeTex.get(id)
              if (!tex) {
                const baked = vtr.bakeTileToTexture(vtr.cachedLayersAt(k.z, k.x, k.y), k.z, sz)
                if (!baked) continue
                tex = baked
                this._multiDrapeTex.set(id, tex)
              }
              const n = Math.pow(2, k.z)
              const west = (k.x / n) * 360 - 180
              const east = ((k.x + 1) / n) * 360 - 180
              const north = (Math.atan(Math.sinh(Math.PI * (1 - 2 * k.y / n))) * 180) / Math.PI
              const south = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (k.y + 1) / n))) * 180) / Math.PI
              const dd = host.rasterRenderer
              if ((globalThis as { __xgisDebugSubRect?: boolean }).__xgisDebugSubRect) {
                // M2-1 verify: draw the tile as LEFT + RIGHT halves via uv-subrect
                // (lon is linear in u, so the split is exact). Seamless reassembly
                // proves the surface-patch sub-rect sampling is correct.
                const mid = (west + east) / 2
                dd.drawDrape(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr,
                  tex, { west, south, east: mid, north }, [0, 0, 0.5, 1])
                dd.drawDrape(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr,
                  tex, { west: mid, south, east, north }, [0.5, 0, 1, 1])
              } else {
                dd.drawDrape(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr,
                  tex, { west, south, east, north })
              }
            }
          }
        }

        // PoC M2-2: adaptive SSE surface quadtree drape. Bake every resident tile
        // (cached) then drape via a screen-space-error-refined quadtree so the limb
        // refines deeper than the centre. Gated on __xgisDebugSurfaceQuadtree.
        // Real opt-in path: experimentalGlobeDrape + a NON-Mercator projection
        // (3/4/5/7 = ortho/azimuthal/stereographic/globe). The debug flag still
        // forces it on for any projection.
        const nonMercDrape = ctx.projType === 3 || ctx.projType === 4 || ctx.projType === 5 || ctx.projType === 7
        const drapeOn = !!((host._experimentalGlobeDrape && nonMercDrape)
          || (globalThis as { __xgisDebugSurfaceQuadtree?: boolean }).__xgisDebugSurfaceQuadtree)
        // Track fill-colour capture to the drape state (once/frame, BEFORE next
        // frame's fills run): on while draping, off the frame after it stops — so
        // a non-draping session pays zero capture cost. Must persist across the
        // frame boundary because the capture happens during the fill render, which
        // precedes this hook.
        if (isFirst) {
          for (const { renderer: vtr } of host.vtSources.values()) vtr.captureBakeColors = drapeOn
        }
        if (isFirst && drapeOn) {
          // Gather the CURRENTLY-resident tiles (bake-on-demand, cached), z-ascending
          // so finer tiles draw on top, then ONE quadtree call (per-leaf slot pool is
          // per-call, so multiple calls/frame would clobber each other pre-submit).
          // Adaptive bake resolution: an over-zoomed tile (curZoom > tileZoom) is
          // stretched on screen, so bake it bigger to keep it crisp — base × 2^Δ,
          // clamped [256, 1024]. Cache key includes the size so a zoom change re-bakes.
          const curZoom = host.camera.zoom
          const force256 = (globalThis as { __xgisDrapeForce256?: boolean }).__xgisDrapeForce256
          const bakeSize = (tileZoom: number) =>
            force256 ? 256 : Math.min(1024, Math.max(256, Math.round(256 * Math.pow(2, Math.max(0, curZoom - tileZoom)))))
          const dataTiles: Array<{ tex: GPUTexture; west: number; south: number; east: number; north: number; z: number }> = []
          for (const { renderer: vtr } of host.vtSources.values()) {
            // Faithful bake: per-layer fill colours were captured this frame
            // (captureBakeColors set above) so the bake paints real colours.
            for (const k of vtr.residentTileKeys()) {
              const sz = bakeSize(k.z)
              const id = `${k.z}/${k.x}/${k.y}@${sz}@${vtr.bakeColorGen}`
              let tex = this._multiDrapeTex.get(id)
              if (!tex) {
                const lc = vtr.cachedLayersWithColorAt(k.z, k.x, k.y)
                const baked = vtr.bakeTileToTexture(lc.map((e) => e.tile), k.z, sz, lc.map((e) => e.color))
                if (!baked) continue
                tex = baked
                this._multiDrapeTex.set(id, tex)
              }
              const n = Math.pow(2, k.z)
              dataTiles.push({
                tex,
                west: (k.x / n) * 360 - 180,
                east: ((k.x + 1) / n) * 360 - 180,
                north: (Math.atan(Math.sinh(Math.PI * (1 - 2 * k.y / n))) * 180) / Math.PI,
                south: (Math.atan(Math.sinh(Math.PI * (1 - 2 * (k.y + 1) / n))) * 180) / Math.PI,
                z: k.z,
              })
            }
          }
          dataTiles.sort((a, b) => a.z - b.z)
          if (dataTiles.length) {
            const stats = host.rasterRenderer.drawSurfaceQuadtree(
              subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr, dataTiles,
            )
            if ((globalThis as { __xgisDebugSurfaceQuadtree?: boolean }).__xgisDebugSurfaceQuadtree)
              console.warn(`[SURFQT] tiles=${dataTiles.length} leaves=${stats.leaves} maxDepth=${stats.maxDepth} curZoom=${curZoom.toFixed(2)} bakeSz=${bakeSize(0)}..${bakeSize(99)}`)
          }
        }

        // ISOLATION: bake ONE tile near the view centre once, then draw it via
        // drawDrape (default) OR the surface quadtree (__xgisIsoQuadtree). Same
        // tile + bake → any green-coverage diff is purely the render path.
        if (isFirst && (globalThis as { __xgisDebugIso?: boolean }).__xgisDebugIso) {
          if (!this._isoTile) {
            for (const { renderer: vtr } of host.vtSources.values()) {
              const keys = vtr.residentTileKeys()
              let best: { z: number; x: number; y: number } | null = null
              let bestD = Infinity
              for (const k of keys) {
                const n = Math.pow(2, k.z)
                const cLon = ((k.x + 0.5) / n) * 360 - 180
                const cLat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (k.y + 0.5) / n))) * 180) / Math.PI
                const d = (cLon - ctx.centerLon) ** 2 + (cLat - ctx.centerLat) ** 2
                if (d < bestD) { bestD = d; best = k }
              }
              if (!best) continue
              const baked = vtr.bakeTileToTexture(vtr.cachedLayersAt(best.z, best.x, best.y), best.z, 256)
              if (!baked) continue
              const n = Math.pow(2, best.z)
              this._isoTile = {
                tex: baked,
                west: (best.x / n) * 360 - 180,
                east: ((best.x + 1) / n) * 360 - 180,
                north: (Math.atan(Math.sinh(Math.PI * (1 - 2 * best.y / n))) * 180) / Math.PI,
                south: (Math.atan(Math.sinh(Math.PI * (1 - 2 * (best.y + 1) / n))) * 180) / Math.PI,
                z: best.z,
              }
              console.warn(`[ISO] tile z${best.z}/${best.x}/${best.y} bounds W${this._isoTile.west.toFixed(0)} S${this._isoTile.south.toFixed(0)} E${this._isoTile.east.toFixed(0)} N${this._isoTile.north.toFixed(0)}`)
              break
            }
          }
          if (this._isoTile) {
            const t = this._isoTile
            const b = { west: t.west, south: t.south, east: t.east, north: t.north }
            if ((globalThis as { __xgisIsoQuadtree?: boolean }).__xgisIsoQuadtree) {
              host.rasterRenderer.drawSurfaceQuadtree(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr, [{ tex: t.tex, ...b }])
            } else {
              host.rasterRenderer.drawDrape(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr, t.tex, b)
            }
          }
        }

        subPass.end()
      })
    }
  }
}

/** Stateless singleton — the opaque bucket pass. */
export const opaquePass: RenderPass = new OpaquePass()
