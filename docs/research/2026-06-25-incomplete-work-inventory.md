# Incomplete-Work Inventory (2026-06-25)

Scope-assessment scan triggered by the owner's observation that a lot of work seems
"started but not finished." Three read-only scanners: experimental/opt-in flags,
scaffolding/PoC markers, and git-history lost/reverted forensics.

## Executive summary — the real shape of it

**It is NOT a pile of lost regressions.** Git forensics found exactly **one**
parallel-branch silent drop (cc497884 outline densify) and it is **already restored**
(#585 / 2eda402c). The owner's "many got lost" worry is not borne out.

What actually accumulated is two different things:

1. **Parked-experimental** — real, substantially-built features sitting behind an
   OFF-by-default flag, awaiting a "promote to default + verify" decision (NOT missing code).
2. **Unfinished subsystems** — genuinely incomplete render features (hillshade, terrain,
   sky, line-gradient, custom heatmap ramp) that are real multi-step work.

Plus a few **stale comments** that make finished work look unfinished (e.g. the globe
earth-surface fill).

### Correction to the live globe-back-lip diagnosis

The earlier "32×16 coarse mesh facets at the limb" explanation was based on a **stale
header comment**. The earth-surface fill mesh is **already 128×64** (`earth-surface-fill.ts:44-51`,
raised specifically to kill the azimuthal/ortho z0 facet, userbug 09). So the residual
globe back-lip is **NOT the mesh facet** — it is: (a) the per-pixel cos_c cull boundary at
the limb, (b) **no under-occluder sphere** to depth-block the far hemisphere, and (c) the
full close (approach-B drape) being **experimental/opt-in, off by default**. The
`earth-surface-fill.ts` header + `projection/AGENTS.md:18` comments ("No runtime consumer
yet / Phase 2 PR 2c placeholder") are **stale** — it shipped.

---

## Prioritized inventory

### A. Parked-experimental — built, behind a flag, decision-to-promote (highest leverage)

| #   | Item                                                         | File                             | State                                  | Impact of turning on                                                                              | Effort                                                                                |
| --- | ------------------------------------------------------------ | -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A1  | **experimentalGlobeDrape** (approach-B vector texture-drape) | map.ts:1205 / opaque-pass.ts:344 | partial+PoC-scaffolded, opt-in         | Closes globe inner-sphere / back-lip / tessellation-gap / over-zoom-jitter (the owner's flagship) | Med-High (clean PoC scaffolding, then default-on + verify; carries its own artifacts) |
| A2  | **enableComputePath** (GPU compute paint eval)               | map.ts:1198                      | finished-but-off, awaiting parity gate | Perf for data-driven styling; no-op today                                                         | Med (build the per-style pixel-parity gate, then flip)                                |
| A3  | **picking** (map.pickAt hit-testing)                         | quality.ts:53                    | flip-ready (off to save 8B/px + MSAA)  | Click/hover feature selection — core UX                                                           | Low (decide default + accept msaa=1 when on)                                          |
| A4  | **graticule** (lat/lon grid)                                 | graticule-renderer.ts:53         | flip-ready                             | Grid overlay                                                                                      | Low                                                                                   |
| A5  | **WebGL2 backend** (?forcegl2=1)                             | gpu.ts:106 / render-loop.ts:648  | PoC-stub (clear+present only)          | ~25-30% browser reach w/o WebGPU                                                                  | **High** (this is the US-003 work in progress on feat/rhi-render-layer)               |

### B. Unfinished render subsystems — real gaps (biggest user-visible holes)

| #   | Item                                                  | Evidence                                                                | Impact                                               | Effort                        |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| B1  | **Hillshade** (raster-dem) — renderer ABSENT          | sources.ts:363 "Batch 4"; untracked hillshade.xgis being scaffolded NOW | raster-dem styles draw nothing                       | High (full Phase-R subsystem) |
| B2  | **3D terrain** — absent                               | sources.ts:363 (coupled w/ hillshade)                                   | flat ground only                                     | High                          |
| B3  | **Sky / fog layer** — absent                          | layers.ts:18 "not yet wired"                                            | no atmosphere on globe/pitched; sky layers dropped   | Med-High                      |
| B4  | **Heatmap custom color ramp** — hardcoded default LUT | heatmap.ts:14, layers-heatmap.ts:108                                    | custom-palette heatmaps wrong colours                | Med (bake interpolate→LUT)    |
| B5  | **line-gradient** (line-progress) — unsupported       | expressions.ts:92                                                       | gradient strokes fall back to solid                  | Med                           |
| B6  | **Multi-page glyph/sprite atlas** — page 0 only       | text-renderer.ts:14, glyph-atlas-gpu.ts:14                              | CJK-heavy / big sprite sheets thrash/drop            | Med                           |
| B7  | **text-pitch-alignment: map** — runtime ignores       | layout-symbol.ts:29                                                     | labels never lie on ground plane in pitched views    | Med                           |
| B8  | **raster tileSize:256** — selector hardcodes 512      | sources.ts:179                                                          | 256-px raster underlays one zoom too coarse (blurry) | Low-Med                       |

### C. Globe back-lip / earth-fill (the owner's immediate question)

| C1 | **Under-occluder sphere** missing + cull-boundary lip | earth-surface-fill (128×64, fine) | the back-lip the owner sees | **Low-Med** — minimal fix: opaque sphere just under EARTH_R, depth-write, before vector pass. Closes lip without the full drape. |
| C2 | Stale "scaffolding / no consumer" comments | earth-surface-fill.ts:1, projection/AGENTS.md:18 | misleads (looks unfinished) | Trivial (comment update) |

### D. Lost / reverted (git forensics) — minimal, mostly intentional

- **cc497884 outline densify** — lost on #387 merge → **already restored (#585)**. ✅
- Intentional, documented losses (confirm only if wanted back): Canvas2D fallback (a61efe63), `.xgvt` format (0540dc1e), runtime TTF/OTF loading (d730dda4, replaced by SDF glyph atlas).
- Reverted-by-design: geodesic triangle midpoint (z=0 banding, 25a33316), FILL_TILE_OVERLAP_FRAC seam fix (#373).
- **No second silent-drop found.**

### E. Converter data-driven gaps (Tier 4 — many small, repetitive)

Constant/last-stop only (expression/zoom/data-driven forms warn + drop): fill/line/fill-extrusion-pattern non-constant, line-offset/line-gap-width/circle-translate/circle-blur data-driven, raster colour adjustments, accessors feature-state/within/image/distance. Each = per-feature IR plumbing, small-moderate, repetitive.

### F. Dead / dormant / debug-scaffolding to clean or finish

- **FrameUniform** class — DORMANT (3rd uniform-packing path kept alive by tests only). Delete or adopt.
- **Globe-drape PoC debug scaffolding** in raster-renderer / opaque-pass (`__xgisDebugDrape`/`Bake`/`Multi`/`Iso`) — promote-or-delete with A1.
- **MGRS/UTM formatters** — hard stubs returning "[pending impl]" (gis-formatter.ts:97).
- **getBounds()** — ignores pitch/bearing + rough lat-span approximation (camera-controller.ts:196).

---

## Recommended sequencing (proposal)

1. **Quick wins / honesty** first: fix stale comments (C2), decide picking/graticule defaults (A3/A4), the globe under-occluder minimal fix (C1) — closes the owner's visible back-lip cheaply.
2. **Decide on the two big parked features**: experimentalGlobeDrape (A1) and enableComputePath (A2) — each needs a "promote + verification gate" mini-project, not just a flag flip.
3. **Pick ONE unfinished subsystem** to actually finish (B1 hillshade is already in-flight). Sequence the rest (terrain, sky) as roadmap, not all at once.
4. WebGL2 (A5) is its own large arc (US-003 in progress) — keep separate.
5. Converter gaps (E) — batch as a low-priority sweep when touching the converter.

The discipline lesson (matches prior owner feedback): these are mostly **decisions deferred**,
not code lost. The fix is to DECIDE (promote / finish / delete) per item, not to re-discover them.
