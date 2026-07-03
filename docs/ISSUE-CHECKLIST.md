# X-GIS — Issue Priority Checklist

Recommended execution order for the 28 open issues, ranked by **value × readiness × risk × how much it unblocks**. Top = do first. Design-complete issues (#795/#797/#798) carry their phase sub-checklists. Generated 2026-07-03.

> **Recommended next 3:** `#746` (cheap triage — may already be closeable) → `#724` (small user-visible bug) → `#798 P1` (pure refactor, DC=0, pays down ~90-literal scatter _and_ unblocks multi-planet).

### ✅ Completed 2026-07-03 (this session — ulw wave 1 + follow-ups)

- **#795 P1** backend construction option — PR #796 ✅
- **#738** blog gutter — PR #794 ✅ · **#737** RenderTargets device guard — PR #791 ✅ · **#792** pick device guard — PR #793 ✅ · **#778** perf audit P3/P5 — PR #789 ✅
- **#724** categorical palette single-source — PR #806 ✅
- **#782** RHI destroy* symmetry — PR #805 ✅ (remaining: compute-webgl2 leak + byteOffset — stays open)
- **#790** TextStage curved-label arena intern — PR #807 ✅
- **#798 P1** Body constant centralization — PR #809 ✅ · **P1b** main-thread render sphere-R — PR #810 ✅
- **Linting infra** (ESLint no-deprecated + Prettier + Husky) — PR #808 ✅
- **#804** deprecated shader-DSL migration — in progress (enabled by the merged no-deprecated rule)

**Remaining tiers need interactive / multi-session work (NOT autonomously completable):** the render-bug family (#799–803, #616, #739, #598, #599, #469, #452, #613) requires real-GPU repro + DC=0 + one-render-subsystem-per-session; the epics (#777, #781) + design (#783) are multi-session.

---

## Tier 1 — Quick wins & triage (cheap, high signal — clear the deck)

- [ ] **#746** `[render/webgl2]` _webgl2-parity red — **re-verify first**. Memory says the spec went 3/3 green; the issue may already be closeable, or only the full-frame polygon path remains. Cheapest possible triage; close or re-scope.
- [ ] **#724** `[C]` categorical() palette hard-capped at 20 via `% 20` — single localized fix; single-source the bound from `CAT_PALETTE.length` (kill the duplicated magic 20) + stop silent wrapping. User-visible colour collisions on countries/states demos. **Small.**

## Tier 2 — Debt-payoff refactor that unblocks a headline feature (high leverage)

- [ ] **#798** `[engine/geodesy]` Multi-planet — single `Body` authority. Do **P1 alone first**: pure CPU refactor, DC=0, kills the ~90 scattered Earth literals — _worth shipping even with no other planet_, and it unblocks Moon/Mars.
  - [ ] P1 — centralize CPU constants into `shared/src/body.ts` (EARTH default, byte-identical, per-file migration + byte-equal ratchet, real-GPU DC=0)
  - [ ] P2 — `configureBody` seam + `{ body }` ctor option + **Moon** (sphere renders from ECEF path, no imagery)
  - [ ] P3 — ellipsoid **Mars** + guarded GPU-const injection + per-body datum wiring
  - [ ] P4 — per-body tile **source/scheme** abstraction (the real epic; datasets consumed here, not built)

## Tier 3 — Ready API improvements (design-complete, user-facing)

- [ ] **#795** `[map/api]` Backend + initial view construction options. Phase 1 (backend) **✅ merged**. Do **Phase 2** next: `center/zoom/bearing/pitch` (+projection) — small, fixes the flash-then-jump, design done.
  - [x] P1 — `backend` construction option (PR #796)
  - [ ] P2 — initial view (center/zoom/bearing/pitch/projection)
- [ ] **#797** `[map/api]` Host DRAWING API (2D + 3D + vertical datum + read/query — fully designed & api-ergonomics-reviewed ×2). Headline new capability; larger effort, gated on a real 100k benchmark.
  - [ ] P0/P1 — real `addImage` atlas (retire the `map.ts:1109` stub) + retained **icon** batch; **gate = 100k icons p95≤16.6ms, N-independent vs setDraws** (non-negotiable)
  - [ ] P2 — circle/point (rides PointRenderer) + static text
  - [ ] P3 — lines + polygons + **extrudedPolygon** (3D volumes)
  - [ ] P4 — patterns + image quads (needs P0 atlas)
  - [ ] P5 — screen-space widening + dev-guards
  - [ ] Datum — `altitudeMode` {ellipsoid/sealevel/clampToGround/relativeToGround} + embedded EGM96 geoid + `ElevationProvider{datum}` seam (lands with the altitude phases)
  - [ ] Read half — `pick`/`pickAll` + `getScreenPosition`/`getBounds` (thin façade over pickAt + projection)

## Tier 4 — User-facing render / correctness bugs (by tractability)

- [ ] **#799** `[render/globe]` OFM Bright + `proj globe` at low zoom near the antimeridian (`#2.40/15.12559/177.84100/300.0/0.0`) renders only a **hemisphere** — likely globe horizon/back-face cull too aggressive at low zoom, or far-hemisphere tile-selection miss.
- [ ] **#800** `[render/globe]` OFM Bright + `proj globe` at low zoom (`#1.5/55.64329/147.08576/315.0/0.0`) renders **labels OFF the globe** into empty space — globe label anchor/RTC projection or missing label horizon-cull. Sibling of #799 (investigate together).
- [ ] **#801** `[render/projection]` OFM Bright + `proj natural_earth` at zoom 0 (`#0.00/0.00000/-145.58202`) — world-wrap **tears / mis-connects** at the seam. Likely a Mercator-`WORLD_MERC` copy offset wrong for a non-Mercator extent (cf. #729, ties to #798 world-extent).
- [ ] **#802** `[render/projection]` OFM Bright + `proj oblique_mercator` (`#1.40/50.54646/-88.35140`) — **torn / discontinuous tile-join** seams. Concrete repro of the known open oblique-polar-tile-tearing (rotated antimeridian + `MERC_LAT_LIMIT` clamp; tile subdivision deferred).
- [ ] **#803** `[render/globe]` ⚠️**RECURRENCE** — vector tile **seams** on globe at z6.73 (`minimal` demo, `#6.73/48.42584/115.40697`); was closed via the RTT raster-drape fix. **Must land a pinned CI regression gate this time** (recurrence-bedrock: fix emitted code not a gate). Re-link the prior closed issue/PR.
- [ ] **#452** Blueprint demotiles — persistent `GPUTextureView` error (likely a device/target lifecycle bug, sibling class to #737; start here — errors are concrete).
- [ ] **#739** `bug` Mercator z0↔0.5 view scale frozen by view-height cap while line width tracks uncapped zoom.
- [ ] **#616** OFM Bright one-way road arrows render off the road centreline (Seoul z22).
- [ ] **#613** Graticule reference labels/lines (Tropics/Equator/Arctic) — wrong zoom-cull + billboarded vs MapLibre.
- [ ] **#598** `bug` Non-Mercator high-zoom jitter (line outline reprojects lossy f32 degrees).
- [ ] **#599** `bug` Globe vector great-circle triangles render as flat chords (drape not wired on main).
- [ ] **#469** ocean_land polar cap — black wedge above Greenland (cap-synthesis coverage gap).

## Tier 5 — Data-driven paint + label correctness (#722–729 sweep remainder)

- [ ] **#725** `bug` `[A]` Tile-fill data-driven color/opacity collapses to the layer default (part 2 — alpha-bake remaining after PR #776).
- [ ] **#726** `bug` `[C/E]` Data-driven line width/color baked at decode zoom; zoom-interp stroke never wired per frame (part 2).
- [ ] **#722** `bug` `[A/C]` Converge tile-point render path onto the inline point path + per-feature point channel.
- [ ] **#727** `bug` `[A]` Label placement diverges between inline-GeoJSON and tile paths.
- [ ] **#728** `bug` `[B]` Label collision/dedup identity depends on transient tile-set / dispatch order / grid phase.
- [ ] **#729** `bug` `[E]` World-copy fan-out dropped after the ECEF migration in some flat-Mercator paths.
- [ ] **#732** Tracking umbrella (post #722/#723) — close as its children land.

## Tier 6 — Engine review arc (#780–784 continuation)

- [ ] **#782** `[quality][rhi]` resource-lifetime leaks + create/destroy asymmetry — batch-1 fixed 5; remaining = `destroy*` API + compute-webgl2.
- [ ] **#790** `perf(map)` TextStage per-frame allocation (#778 P4 carve-out) — needs the cross-file TextStage API change.
- [ ] **#784** `[perf]` engine per-frame allocations (view-matrix/camera/staging) — batch-1 fixed most; profiler-confirm the rest.
- [ ] **#783** `[quality][dx]` engine RHI/GPU API ergonomics — design-heavy (the mechanical items shipped in #786/#787; remainder needs design).
- [ ] **#781** `[epic][arch]` @xgis/engine not content-blind — huge relocation epic; slice 1 shipped (#788), rest is DC-gated/interdependent (**Gate-6 first** per the generic-engine rule).

## Tier 7 — shader-dsl features + hygiene

- [ ] **#804** `[map/shaders]` Audit `map/src/shaders/dsl/` for **deprecated shader-DSL APIs** and migrate to the blessed forms (byte-identical emit, golden-gated) + a guard to prevent re-introduction. Cheap-ish hygiene; do before/alongside the shader-dsl feature work.
- [ ] **#625** Route compiler compute-gen through the DSL IR + optimizer.
- [ ] **#626** `override` (pipeline-overridable constants) to collapse the variant permutation.
- [ ] **#627** Optimizer completeness (auto-inline, tree-shaking DCE, loop unroll, GVN, O-levels).
- [ ] **#628** Language-feature optimization knobs via caps (immediate / f16 / subgroups / packed-dot / @invariant).

## Tier 8 — Large epics (ongoing, run in parallel slices)

- [ ] **#777** `[epic]` Mapbox style-spec completion — 60 remaining properties, phased (icon/sprite → DEM/hillshade → expressions → labels → misc → reclassify).

---

### Ranking rationale

1. **Cheap triage first** (#746, #724) — clear closeable/small items before committing to big work.
2. **Debt-payoff that also unblocks** (#798 P1) beats pure features — one refactor pays down ~90 scattered literals _and_ opens multi-planet, at DC=0 risk.
3. **Design-complete API work** (#795 P2, #797) — already reviewed; lowest design risk, high user value.
4. **User-facing render bugs** before internal-quality items — visible correctness first.
5. **Engine-arch epics** (#781/#783) and **large feature epics** (#777) last / sliced — highest effort, most interdependent; run as focused sessions.

_Discipline reminders (per CLAUDE.md): every render-affecting change gates on real-GPU **DC=0** (directional pixel-diff + 16-split read); one render subsystem per session; `bun run build` is the tsc authority; fail-before tests for every bug fix._
