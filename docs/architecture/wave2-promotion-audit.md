# wave-2 promotion audit — B1 / B2 / B3 (2026-07-27)

> **Track B audit deliverable** of `engine-map-rebalance-program.md` §4 — read-only, no code
> changes. §4 nominated three candidate groups for map→engine promotion; this audit measures
> them against §4's own bar (**strip-X-GIS** + **≥2 real consumers or a folded twin**) with a
> full import/consumer/ratchet census, and corrects two of §4's premises where the evidence
> came back different. **Execution stays sequenced behind Track A as §9 orders it** — this doc
> changes _what_ wave-2 contains, not _when_ it runs.

## 1. Corrections to §4 (the evidence beats the nomination)

Three claims in §4 were audited adversarially; two do not survive.

**1.1 — "B1's SDF core has zero geo/compiler coupling; couplings concentrate in
`text-stage*`" — HALF-REFUTED.** The geo half holds: `@xgis/geo` imports in `map/src/text/`
= **0** (and 0 in `sprite/`). The compiler half is false as stated. Outside `text-stage*`,
five B1-adjacent files import `@xgis/compiler`:

| Site                                                                                             | Import                               | Kind      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------ | --------- |
| `text-renderer.ts:26`                                                                            | `{ vertexField }`                    | **value** |
| `text-vertex-format.ts:1` (transitive dep of text-renderer)                                      | `{ buildFormat, type VertexFormat }` | **value** |
| `format-value.ts:23`, `formatters/number-formatter.ts:16`, `formatters/datetime-formatter.ts:22` | `type { FormatSpec }`                | type      |

Plus one SDF-core → orchestration-types edge: `text-wrap.ts:17` imports from
`text-stage-types.ts`, which is itself `LabelDef`-typed. Consequence: B1's severance list is
longer than §4 stated (§3 below) — still injectable (the types are narrow), but the move is
not the "already clean, just carve" §4 implied.

**1.2 — "heatmap-targets + flow-targets → one `PingPongTargets` primitive" — REFUTED.**
The two are not the same shape wearing two names. `HeatmapTargets` is **two fixed roles**
(accum/blur, no swap); `FlowTargets` is a **true ping-pong** (`flipped`/`swap()`), sized from
the coverage **grid** (camera-independent, `FLOW_MAX_DIM` capped) where heatmap sizes from
the **canvas**; flow's format is runtime-selected (`r16float` vs `rgba8unorm` by
`floatRenderTargets`) and part of its recreate gate, heatmap's is fixed; flow carries a
`needsClear` re-arm obligation (IBFV is a recursive filter) that heatmap has no analogue
for — ten deltas total against a small shared core (lazy pair, size-keyed recreate,
null-don't-destroy device self-heal). A union type serving both would be four knobs deep on
day one. **Withdrawn**; the shared self-heal idiom is a pattern to copy, not a class to
extract.

**1.3 — B3's "small generics" list — TWO RECLASSIFIED AS CONTENT.**
`renderer-helpers.ts` interpolates **Mapbox style stops** (`interpolateZoom({zoom,value}[])`,
`:87-119`) and keys on `ShaderVariantInfo.fillExpr`; `line-pattern.ts` reads **Mapbox paint
properties by name** (`line-blur` `:221`, `line-translate` `:230-233`) against the
line-uniform-slot SoT. No imports ≠ no coupling — the vocabulary is the coupling. Both fail
strip-X-GIS; moved to the anti-candidate list.

## 2. Census verdict table

Bar: **strip** = strip-X-GIS passes today (after listed severances) · **consumers** = real
non-test importers outside the candidate's own subsystem (the published-barrel re-export in
`map/src/index.ts` not counted) · **raw** = `raw-webgpu-ratchet` BASELINE tokens (absence is
a proven zero — the gate is strict-equal).

| Candidate                                                                                                                         | Consumers                                                              | Raw              | Verdict                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1 SDF/glyph core as a unit** (`sdf/**` 9 files, `text-wrap`, `text-collision`, `label-fade`, `sdf-shape`, `paired-symbol-box`) | individually 0–4; cohesive subsystem (internal graph)                  | **0** across all | **ELIGIBLE as a unit** — the promotion unit is the subsystem, not files; justified by the P3 twin-fold + the engine text story, not per-file counts                                                                      |
| `text-renderer.ts`                                                                                                                | 0 outside `text/`                                                      | **13**           | **BLOCKED** — raw tokens (P6 class) + `wrapWebGpuPass` + `../render/material/text-material` escape + `vertexField`; moves LAST, after A-track retypes                                                                    |
| `sdf-shape.ts`                                                                                                                    | **4** (`map.ts`, `point-renderer`, `line-renderer`, `scene-renderers`) | 0                | **ELIGIBLE, first mover** — only `RhiBuffer/RhiDevice` types                                                                                                                                                             |
| `sdf/pbf/glyph-provider.ts` seam                                                                                                  | 2 (`map.ts`, `map-types.ts`)                                           | 0                | ELIGIBLE with the unit                                                                                                                                                                                                   |
| **B2** `host-atlas-packer.ts`                                                                                                     | 2 (the two atlas mirrors — an already-folded twin authority)           | 0                | **ELIGIBLE, rides P3**                                                                                                                                                                                                   |
| `icon-collide-overlap.ts`                                                                                                         | 1 (`icon-stage`)                                                       | 0                | ELIGIBLE with the unit — already severed `SpriteInfo` via its own structural `CollideSprite` subset (the severance pattern to copy)                                                                                      |
| `icon-renderer.ts`                                                                                                                | 0 (only `icon-stage`)                                                  | **12**           | **BLOCKED** — raw tokens + upward type edge onto `icon-stage` (`:16`) + material import; after A-track                                                                                                                   |
| **B3** `heatmap-targets.ts`                                                                                                       | 3                                                                      | 0                | **DEFER to post-A1** — carries a deliberate parallel native+RHI set ("kept … so the WebGPU path stays byte-identical"); the twin-frame elimination (#1046 F-phases) is what makes it single-set, then it is a clean move |
| `flow-targets.ts`                                                                                                                 | **0** (consumer is in-flight in open PR #1380)                         | 0                | **DO NOT TOUCH** until #1380 lands; re-audit then                                                                                                                                                                        |
| `event-dispatcher.ts`                                                                                                             | 1                                                                      | 0                | NOT nominated — surface is content-typed (`XGISFeatureEvent`, injected `clientToLngLat`); 1 consumer                                                                                                                     |
| `vector-drape-cache.ts`                                                                                                           | 1                                                                      | 0                | NOT nominated — `drapeZoomBucket` is tile-pyramid semantics; 1 consumer                                                                                                                                                  |
| `oit-pass.ts`                                                                                                                     | 1 (`pass-chain`)                                                       | 0 (see §5)       | NOT a standalone move — subsumed by **P5 `FullscreenComposePass`**; reaches 4 map internals + takes `FrameContext` (adjudicated anti-candidate)                                                                          |
| `renderer-helpers.ts`, `line-pattern.ts`                                                                                          | 3 / 2                                                                  | 0                | **ANTI-CANDIDATES** (§1.3 — style vocabulary)                                                                                                                                                                            |

Raw-token blockers across B1+B2 territory total **62 of the 575 baseline tokens** (6 files;
the orchestrators `text-stage` 3 and `icon-stage` 8 stay in map regardless).

## 3. B1/B2 severance list (each is a small PR-able seam, before or with the move)

1. `vertexField`/`buildFormat` (`text-renderer.ts:26`, `text-vertex-format.ts:1`,
   `icon-vertex-format.ts:1`, `icon-renderer.ts:26`) — the vertex-format authority is
   `@xgis/rhi`'s neutral contract (#929 B3 homed `VertexFormat` there); route these through
   the RHI seam instead of `@xgis/compiler`.
2. `FormatSpec` (3 formatter files) — a structural formatting descriptor; either lift the
   type to a neutral home or keep the formatters in map (they are locale/format policy, not
   GPU machinery — cheapest correct answer: **keep in map**, drop from B1).
3. `text-wrap.ts:17` → `text-stage-types` — extract the two shaping types
   (`WrappedLineRange`, `KPBreak`) into the core, invert the edge.
4. `SpriteInfo` protocol vocabulary (7 importers incl. 3 B2 candidates) — replicate
   `icon-collide-overlap`'s pattern: each mover declares the structural subset it reads;
   the Mapbox wire type stays in `sprite-atlas-host.ts`.
5. `../__profile__/alloc-counter` (`text-renderer.ts:20`) — inject, as `UniformRing` did
   with its perf-marks (#991 P2 precedent).
6. `text-renderer.ts:25` → `material/text-material` — the draper import inverts when the
   renderer moves (map composes; the core never names a map material).

## 4. Atlas primitive (P3) — measured requirements union

The four implementations (`GlyphAtlasGPU`+`AtlasState`+host, `HostSpriteAtlasGpu`,
`HostSpriteAtlasRhi`, `SpriteAtlasGPU`) diverge on every axis; one engine `AtlasTexture`
must carry:

- **RhiDevice-only** (two of four are native today — ratchet rows 14/12 gate the fold);
  formats `r8unorm` + `rgba8unorm` with bytes/px **derived from format** (call sites
  hard-code `slot.size` and `w*4` today); three page geometries (N growable square / 1
  fixed square with never-recreate identity / 1 image-sized); per-instance usage sets
  (incl. the load-bearing `'render'` bit — Dawn rejects the external-image copy without
  it); **pluggable allocation** (uniform-grid LRU with `evictedKey` feedback / shelf
  warn-and-skip / external rects); dirty-tracking superset (none ⊂ boolean ⊂ record queue)
  with the glyph-only eviction queue + generation counter staying glyph-side; cached
  per-page views + one clamp-to-edge sampler.
- **G10 confirmed at the seam**: `RhiDevice.copyExternalImage` has no destination origin
  (`rhi/src/rhi.ts:454-459`) — exactly why `host-sprite-atlas-rhi.ts:39-45` CPU-rasterises
  through `OffscreenCanvas` while its WebGPU twin does a GPU sub-region copy. G10 lands
  first or the fold ships a regression on one backend.
- Load-state (`getState`/`whenReady`) and `SpriteInfo` metadata lookup are **not** atlas
  concerns — they stay in map.

## 5. Side finding — a ratchet blind spot (recorded, not new debt)

`oit-pass.ts:92` calls `host.ctx.device.createBindGroup(...)` — raw WebGPU reached through
**inferred** types, so it carries zero `GPU[A-Z]` identifiers and is invisible to the
raw-WebGPU ratchet's signal (the file is absent from BASELINE while doing raw work). The
same class exists in the other pass bodies' `ctx.encoder`/`ctx.device` touches. This is not
new debt — the sites are #991's known P4/P5/P6 rows and die with the `FrameContext` retype —
but **close-out must not be declared on the token count alone**: the program DoD's
companion signal is #991 P6's grep gate (`\.device\.(create|queue)|GPUShaderStage|…`), which
does catch inferred-type raw calls. Recorded here so the DoD check runs both signals.

## 6. Revised wave-2 sequencing (delta to program §9 only)

```
unchanged:  B* executes after A4-P3 lands the atlas primitive (+ text-renderer/icon-renderer
            additionally after their A-track raw-token retypes)
new:        first movers inside the wave = sdf-shape → host-atlas-packer(+P3) → SDF core unit
            heatmap-targets fold re-enters only after A1 deletes its native twin set
            flow-targets re-audited after PR #1380 merges (its first consumer is in flight)
withdrawn:  PingPongTargets unification; renderer-helpers / line-pattern nominations
map-keeps:  formatters/FormatSpec cluster, text-stage*/icon-stage orchestrators,
            sprite-atlas-host (Mapbox protocol), event-dispatcher, vector-drape-cache
```

## 7. Eligible-done, per §4's bar (what execution must prove per move)

Move lands only with: severances from §3 done (edge inverted or injected, no re-export of a
map type from engine); tests travel with the primitive (#991 principle 9); dep-direction +
raw-WebGPU ratchets green with rows burned in the same commit; §8 verification protocol of
the program doc (build → whole-repo vitest for cross-package moves → render gates where a
render path is touched — the SDF core is pure CPU, so its gate is unit + glyph-parity
fixtures, not pixel diffs).

---

_Census: two-pass (imports/consumers/ratchet) over `map/src/text/**`, `map/src/sprite/**`,
and the seven B3 files, measured on this branch at `dc1e992`; pivotal claims (compiler
import in `text-renderer.ts:26`, flow-targets' zero consumers, the `oit-pass.ts:92`
inferred-type raw call + its BASELINE absence) re-verified first-hand. Companion:
`engine-map-rebalance-program.md` (§4 nominations, §9 sequencing), EPIC #991 (P3/P6 specs),
#1046 (A1/F-phases)._
