# Audit ⑩ — Input / camera / picking

_Deep-research synthesis, 2026-06-08. File:line audit of X-GIS input/camera/picking merged with GPU-picking and map-camera/gesture research (MapLibre/Mapbox/deck.gl/three.js). Part of the 10-audit series. Claims cited inline._

---

## TL;DR

Solid gesture/camera core (clean pointer state machine, idempotent drag anchors, async pick readback, pitch-lock for 2D azimuthals) with a cluster of **concrete, mostly-known-pattern bugs** the research pins precisely:

- **Picking ignores layer visibility** — the render pass filters `visible === false` but the pick pass doesn't, so **invisible layers stay clickable** (UX-contract break, MED-HIGH).
- **Pick coordinate rounding at DPR≥2** — `Math.floor` of the DPR-scaled coord biases the sample toward the corner of the device-pixel group → edge misses on retina (the classic off-by-one the three.js pickers warn about).
- **Unproject above the horizon at high pitch returns `null`**, and the drag-anchor fallback then pans by raw screen delta — which scales wildly with pitch ("map jumps"). Mapbox hit the same class and **clamps to the horizon** instead.
- **Pinch-rotate has no hysteresis** — any pinch-angle jitter spins the map during an intended pure zoom; MapLibre's whole gesture design is **adaptive dead-zones** (which X-GIS lacks).
- **Globe pole invariant break** — `centerLatDeg` exceeds 85.051129° while `centerY` is clamped, violating the documented `centerLatDeg === mercatorYToLat(centerY)` invariant.

---

## A. Architecture (as audited)

`controller.ts` PanZoomController (pointer map + `isDragging`/`isRotating`/`isRotatePending`, 4px click dead-zone, post-release inertia decay 0.90×/frame capped ±15, double-tap zoom). `camera.ts` (centerX/Y in Mercator m, zoom/bearing/pitch, `centerLatDeg` true latitude, min/max zoom 0-22, `MERCATOR_LAT_LIMIT`, MVP cache by value). Picking: single-sample **RG32Uint** pick texture (R=featureId, G=layerId|(instanceId<<16)), async `mapAsync` 1-frame-latency readback via a staging pool, hover state machine firing enter/leave/move, feature lookup via `_featureIndex` with `feature.id`→`properties.id`→array-index fallback (matches the encoder). This is the standard **GPU color/ID picking** pattern — render IDs to an offscreen buffer, read the pixel under the cursor — preferred over CPU ray-cast for complex geometry [webglfundamentals, high].

## B. Findings (file:line, severity)

### B1 — Picking ignores layer visibility — MED-HIGH

The render pipeline skips `show.visible === false` (`bucket-scheduler.ts:217`), but **the pick pass has no parallel gate** (`interaction-controller.ts:110-166`), so a hidden layer's features are still returned on click [audit #2]. Breaks the invisible⇒unclickable contract; a real concern if visibility gates unfinished features. **Fix:** filter classified shows by visibility before the pick pass (or check `show.visible` on the pick result).

### B2 — Pick coordinate rounding at DPR≥2 — MEDIUM

`interaction-controller.ts:118-119` `Math.floor((clientX-rect.left)*(canvas.width/rect.width))` truncates the DPR-scaled float, biasing the sampled device pixel toward the **top-left of the 2×2 group** → ~0.5-px error at DPR 2, ~1-px at DPR 3, causing edge misses [audit #1]. The research is explicit: mouse coords are CSS pixels and must be scaled by `devicePixelRatio`, and the `floor`/Y-flip is _the_ classic off-by-one in GPU pickers [three.js #17257; webglfundamentals, high]. **Fix:** center-round (`Math.floor((x+0.5)*dpr)` or `Math.round`).

### B3 — Unproject above horizon → null → broken fallback pan — MEDIUM

`unproject.ts:66-69` returns `null` when the ray is near-parallel to the ground plane (pitch→85°, pixels above the horizon); the drag path then falls back to **screen-space delta pan** that at high pitch moves far more world-metres per pixel near the horizon ("map jumps at high pitch") [audit #3]. Mapbox solved the same singularity by **clamping above-horizon unproject to the horizon point** (not returning null) — though note their clamp itself once regressed 2D `panBy` (issue #10215), so it needs care [high]. **Fix:** perspective-correct delta pan (unproject the _delta_ endpoints) or a horizon clamp.

### B4 — Pinch-rotate has no hysteresis — MEDIUM

`controller.ts:256-300` applies `camera.rotate(-delta)` for **any** pinch-angle change, so finger jitter (~2-3°) spuriously rotates during an intended pure zoom [audit #5]. MapLibre's gesture system is built on **adaptive dead-zones** that X-GIS lacks: rotation activates only past `ROTATION_THRESHOLD = 25px / circumference × 360` (so closer fingers need more angle), pinch-zoom past a `0.1` zoom-delta threshold, and pitch only when both fingers move vertically in the same direction [MapLibre two_fingers_touch.ts, high]. **Fix:** add a rotation dead-zone (≥~3°, ideally finger-spacing-adaptive) and a pinch-zoom threshold.

### B5 — Globe pole latitude invariant break — MEDIUM

On globe pan, `centerLatDeg` can be written to e.g. 87° while `centerY` is clamped to 85.051129° (`camera.ts:826-837`), violating the documented invariant `centerLatDeg === mercatorYToLat(centerY)` for |lat|≤85.05 — so `mercatorYToLat(centerY)` and `centerLatDeg` disagree near the pole, corrupting tile selection/unproject there [audit #9]. The Mercator pole singularity (y→∞ at ±90°) is _why_ the clamp exists [Web Mercator, high], but the two latitude representations must stay reconciled. **Fix:** keep a single source of truth for latitude on the sphere path, or clamp `centerLatDeg` consistently.

### B6 — Inertia & DPR races — MEDIUM/LOW

Nested inertia: a new `pointerdown` during inertia decay doesn't cancel the animation, so the coasting pan and the new drag compound into chaotic motion (`controller.ts:350-358`) — **fix:** cancel inertia on `pointerdown` [audit #11]. Adaptive-DPR canvas/dpr mismatch mid-gesture produces a center-shift jump when DPR restores (`map.ts:152`/`controller.ts:901`) [audit #8]. Plus low-severity: inertia velocity cap loses flick-intensity info, bearing-NaN silent reset masking an upstream bug (should `xlog.warn`), redundant right-click rotation/click gate, and MVP-cache fragility if a future public `centerX` setter is added [audit #6,#7,#10,#12].

## C. What's robust

Clean gesture-state isolation (pointer map + cancel cleanup); **idempotent drag anchors** (`panToScreenAnchor` in absolute world coords — elegant and correct); async pick readback + staging pool (no per-frame alloc); feature-index fallback matching the encoder (pick IDs round-trip); pitch-lock for flat azimuthals; bearing normalization `((b%360)+360)%360`. The pick pass correctly reuses the render MVP for ID rendering, which is what keeps picking correct under pitch/bearing/zoom [deck.gl/three.js, high] — the residual transform drift (B-audit #4) is only the 1-frame async-readback latency, not a wrong matrix.

## D. Top fixes (ranked)

1. **Visibility filter in the pick pass** (B1) — clearest contract break; small.
2. **Center-round pick coords** (B2) — one-line DPR-accuracy fix.
3. **Pinch-rotate dead-zone** (B4) — the MapLibre thresholds are a proven recipe; removes the "spins during zoom" complaint.
4. **High-pitch unproject clamp / perspective-correct fallback pan** (B3) and **reconcile globe latitude** (B5) — both real but more involved.

---

## Sources

**Codebase audit (file:line):** `controller.ts:122,129,150-169,188,227-231,256-300,327-332,342-358,367,901` (gestures/inertia/click), `camera.ts:32-40,210-282,826-837,861,1020` (state/cache/invariant), `interaction-controller.ts:110-166,118-119,238-239` (pick coords/visibility), `unproject.ts:66-69` (ray-plane), `bucket-scheduler.ts:217` (render visibility), `event-dispatcher.ts`.
**Picking research:** webglfundamentals GPU picking (ID-to-color, RGBA 32-bit encode) [high]; webgpufundamentals copying-data (mapAsync readback sync point) [high]; deck.gl picking (encodePickingColor, same-MVP pick render, 16M/layer) [high]; three.js GPU picker + #17257 (×devicePixelRatio, floor off-by-one) [high]; Mapbox queryRenderedFeatures (geometry-based, tile-boundary duplication — contrast) [med-high].
**Camera/gesture research:** Mapbox/MapLibre camera docs (4-property model, pitch 60→85, lat clamp 85.051129, flyTo van Wijk curve 1.42) [high]; MapLibre two_fingers_touch.ts (pinch 0.1, ROTATION_THRESHOLD 25px adaptive, pitch same-direction-vertical) [high]; drag_pan inertia defaults [high]; ScrollZoom focal-point + rates [med-high]; Mapbox #10215 (unproject horizon clamp + the 2D panBy regression) [high].

_Confidence: the codebase audit (direct read, 12 bugs with triggers) and MapLibre/Mapbox/three.js primary sources are load-bearing. The pinch-rotate, unproject-horizon, and DPR-pick findings map 1:1 onto documented reference-engine mechanisms X-GIS is missing._
