# P2 Carve Plan — @xgis/engine (content-blind) ⟂ @xgis/map (content)

> Synthesized 2026-07-01 from a 5-scout read-only survey of the current coupling
> (PassHost→RenderNode, MapRenderer god-object, SceneView/FrameContext content
> handles, §8.5 zero-coupling ratchet, fill raw-delete residuals). Authority peers:
> [render-graph-pass-scheduler.md](./render-graph-pass-scheduler.md) (§2.2/§4/§8.1/§9),
> [engine-content-split.md](./engine-content-split.md) (§5.2/§7); ratchet =
> `runtime/src/engine/architecture-invariants.test.ts`.

## Load-bearing realization (governs the whole order)

`PassHost = Pick<XGISMap, …>` (pass-hosts.ts:23-103) **is** the engine→map back-edge.
Every pass type-references `XGISMap`. Inverting PassHost→`RenderNode[]` where @xgis/map
_implements & registers_ nodes is what makes the §8.5 Gate-6 ratchet pass _by
construction_ — not a regex bolt-on. So the package move is **last**; the couplings are
dissolved **first**, in dependency order (innermost handle leaks → outermost scheduler).

## Universal per-step gate (every step is a mechanical refactor → exact identity)

- **Byte-identity:** `tsc --build shader-dsl/tsconfig.json` then `tsc -p runtime/tsconfig.json`
  green; shader-emit goldens unchanged (`bun run build` golden compare); `getDrawStats()`
  (draw/vert/tri/line counts) and uniform-reflect byte dump identical before/after.
- **DC=0:** real-GPU sweep (OFM-Bright merc z14, globe, merc z18.25 pitch≈50, heatmap style)
  → `compare-diff.py` **DC must equal 0** (full identity — this is a refactor, gate hard on
  0, not on direction). NOTE: per the in-repo verification lesson, prefer an in-place A/B
  where one exists; for a pure relocation, capture a GPU command-stream trace and assert equal.
- **Ratchet:** `architecture-invariants.test.ts` green (LOC ceilings only shrink; projType
  allowlist unchanged until Step 3; Gate-6 added in Step 5).

---

## Step 0 — Dead OIT subsystem + fill raw residuals (revised after a re-trace)

- **VERIFIED DEAD (11-link proof, re-traced from source 2026-07-01):** `isOitExtrude`
  (bucket-scheduler.ts:299) is a hardcoded immutable `false` — **sole writer** — ⇒ `oit=[]`
  (`:203`/`:385`) ⇒ `hasOit=false` (scene-view.ts:66, sole writer) ⇒ `oit-pass.shouldRun=false`
  (oit-pass.ts:19) ⇒ `render-loop.ts:461` never executes ⇒ `'oit-fill'` phase never emitted
  (oit-pass.ts:65 is the only emitter) ⇒ VTR `isOitFill=false` (vector-tile-renderer.ts:2575)
  ⇒ the `extrudedOITPipeline()` OIT arm (`:2911-2913`/`:2998`) is unreachable. ∎ DC=0 by
  absence of execution. (`translucent-pass.ts` is a SEPARATE live path — never touch it.)
- **BLAST RADIUS (the survey under-counted "no live caller"):** the whole OIT subsystem is
  dead, ~16 prod + ~5 test files. The getter (bind-group-registry.ts:210) has only the
  unreachable VTR caller, BUT the **pipeline field** `fillPipelineExtrudedOIT`
  (pipeline-factory.ts:218/861 → renderer.ts:117) has **6 live compile-time callers**
  (`map.ts:715/1355/2755`, `source-manager.ts:246/447`, `geojson-polar-cap-show.ts:70`) that
  build + `setOITPipeline(...)` it (it just never reaches a draw); plus the dead-but-plumbed
  compose half (`oitComposePipeline`/`oitComposeBindGroupLayout`, pipeline-factory.ts:222-223/
  950-951, oit-pass.ts:84/90) and OIT targets (`ensureOit`/`oitAccumTexture`/`oitRevealageTexture`,
  render-targets.ts:46-88/258). Full deletion also hits `oit-pass.ts` (delete file),
  `pass-hosts.ts:41/144 OitPassHost`, `pass.ts:20/32/49`, `scene-view.ts`, `render-loop.ts:32/461`,
  - tests render-targets/scene-view/map-rebuild-layers/source-manager-bounds-fit-gate/bundle-cache-key.
- **DECISION — fold OIT removal into Step 4, do NOT delete standalone.** The OIT path is a
  _deliberate_ "future opt-in" scaffold (pipeline-factory.ts:861 comment), and its surface
  (`OitPassHost`, `pass.ts`, the `oit-fill` phase) IS the PassHost/RenderPass machinery Step 4
  inverts. A dead pass simply won't be registered as a `RenderNode` during the Step 4 inversion
  → it drops from the live path there, in context, without a premature 16-file subsystem delete.
- **Remaining Step 0 (in-budget, optional):** the per-style-extrude raw residual
  (`polygon-fill-material.ts`) + the fill raw else-branch delete are gated on the fill-pattern
  RHI routing (P1.6 — `show.fillPattern` propagation blocker), NOT on OIT. Keep raw until then.

## Step 1 — Split MapRenderer god-object → `FrameRenderer` (engine) + `MapRendererContent` (map)

- **Engine-KEEP** (rename `MapRenderer`→`FrameRenderer`): `ctx`, `_pipelines` (renderer.ts:108),
  `uniformRing`/`uniformBuffer` (:150/:154), `bindGroup` rebuild (:415-442),
  `beginFrame/endFrame/allocUniformSlot/stageUniformSlot` (:445-466), compute path
  (:272-299,:313-344), `rebuildForQuality` (:375-388), `ensure{Overdraw,HeatmapBlur,HeatmapCompose}`
  (:393-407), pipeline getters (:112-149), `getDrawStats` (:181-201).
- **Content-MOVE:** `StyleProperties` (:35-82), `RenderLayer` (renderer-types.ts:233-252),
  `layers[]` (:172), `addLayer` (:473-649), `renderToPass` (:787-938), `setPalette/SpriteAtlas`
  (:660-742), `_graticule` (:177,:260-267,:927), `uniformDataBuf` 192B paint struct (:92).
- **Invariant:** engine owns RHI/ring/pipeline _machinery_; content owns _what to paint_.
  `MapRendererContent` reaches engine only via narrow accessor thunks. No content type
  (`ShowCommand`, `StyleProperties`, atlas views) survives in `FrameRenderer`.
- **Fragile:** ring-slot allocation order must not reorder — gate the uniform-reflect dump per
  draw, not just totals. Move `renderToPass` body verbatim; do NOT centralize uniform writes
  (byte-diverging Phase-B, out of scope).

## Step 2 — Invert SceneView content handles (`DrawItem` stream)

- **Inverts:** `ClassifiedShow.{fp,lp,bgl,fpG,fpGF,fpF,lpF,vtEntry.renderer}` (bucket-scheduler
  ~:360-368) stop being read by engine passes. opaque/oit/translucent passes (opaque-pass.ts:150,
  oit-pass.ts:60, translucent-pass.ts:23) call `cs.vtEntry.renderer.render(...)`. Introduce an
  engine-side opaque `DrawItem`/`drawVectorTiles(encoder, pass)` callback owned by the content
  node; engine sees `SceneView.opaque: DrawItem[]`, never `GPURenderPipeline`.
- **Invariant:** `SceneView` carries **no content-typed GPU object**.
  `hasTranslucent/hasOit/hasPoints/hasHeatmap/resolveOwner` stay (engine-generic booleans).
- **Fragile:** `resolveOwner` ('points'|'composite'|'opaque') must be computed identically —
  gate the chosen color/resolve view per frame + GPU command-stream trace equality.

## Step 3 — Neutralize FrameContext content scalars (opaque projection token)

- **Inverts:** `projType` (render-loop.ts:288/303, azimuthal-when-tilted at :105-121),
  `centerLon` (:185), `centerLat` (:194-196), `visibleWorldCopies` (label-pass.ts:358-359).
  Replace the three scalars with one **opaque `ProjectionToken`** (engine treats it as an
  undecodable handle); the azimuthal-when-tilted + mercatorYToLat math moves to a @xgis/map
  producer. `visibleWorldCopies` is removed from FrameContext → label-node-local state.
- **Invariant:** engine FrameContext is projection-blind. After this, the `projType ===/!==`
  allowlist (Gate-4) can drop its render-loop entries.
- **Divergence — CALL OUT:** `visibleWorldCopies` is produced mid-frame inside the label pass —
  cannot be a pre-frame token. Still byte-identical (same array/values), but forces label
  placement to own its production. Gate `_projection-label-onscreen` + label-anchor-parity.

## Step 4 — Invert PassHost → data-driven `RenderNode[]` / `PassDef[]`

- **Inverts:** delete `PassHost` (pass-hosts.ts:23-103) + `RenderPass` (pass.ts:57-65). Engine
  defines `RenderNode { shouldRun(SceneView): bool; execute(FrameContext): void }` + a **flat**
  `PassDef[]` scheduler (reject DAG per the prior-art ruling). The 8 pass impls
  (background/opaque/oit/translucent/points/label/heatmap/overdraw-compose) become content
  `RenderNode`s registered by @xgis/map via `registerRenderer`/`registerNode`. Engine iterates
  `PassDef[]` in the **frozen order** with existing `shouldRun` predicates.
- **Invariant:** engine no longer type-references `XGISMap` anywhere — back-edge gone.
- **Fragile:** mid-frame mutations (Step 3 world-copies, Step 2 resolveOwner) must run at the
  same scheduler slot — keep node boundaries == current pass boundaries; snapshot the
  `RenderPassDescriptor` per node (§8.1) before/after, assert byte-equal.

## Step 5 — Physically relocate content + add Gate-6 ratchet (close by construction)

- **Moves:** content `RenderNode` impls, `MapRendererContent`, `StyleProperties`, `RenderLayer`,
  atlas/graticule, paint-eval consumers (`label-pass` `evaluate/makeEvalProps/resolveColor`, VTR,
  `POLYGON_*_FORMAT` users) into `@xgis/map`. Engine retains: RHI, FrameRenderer machinery,
  RenderNode contract + scheduler, FrameContext infra, RenderTargets, pipeline-factory _machinery_.
- **Gate-6** added to architecture-invariants.test.ts: `runtime/src/engine/**` regex
  `import … from '@xgis/map'` ⇒ offenders must be `[]` (incl. `import type`). `@xgis/compiler`
  stays an allowed neutral peer — Gate-6 blocks @xgis/map **only** (do not over-scope to ban compiler).
- **Invariant (deliverable):** engine→@xgis/map imports = **0, enforced by ratchet**.
- **Divergence:** none — source-level move, zero runtime bytes change.

---

## Divergence accounting (honest)

No step is inherently non-byte-identical — the carve is mechanical end-to-end. Byte-identity
_risk_ concentrates at three named slots: (1) ring-slot order (Step 1) → uniform-reflect
per-draw dump; (2) `resolveOwner`/draw-call order (Step 2) → command-stream trace equality;
(3) `visibleWorldCopies` mid-frame production (Step 3) → label-anchor-parity.

**Order rationale:** Step 0 shrinks surface; Steps 1-3 dissolve the three residual channels
(god-object → handles → scalars) inner-to-outer so PassHost inversion (Step 4) has nothing
content-typed left to reference; Step 5 relocates + ratchets only once the back-edge type is
already deleted — so Gate-6 is green the moment it is added, never a flag-day.

**Right-sizing:** flat `PassDef[]` (no DAG); compiler kept as allowed peer; Phase-B uniform
centralization explicitly excluded (byte-diverging, not part of this carve).
