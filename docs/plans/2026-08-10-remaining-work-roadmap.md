# 2026-08-10 — Remaining-Work Roadmap (full open-backlog survey)

**Method.** Every open issue (98) was read body **and** comments — comments are the
authority, bodies go stale (CLAUDE.md §12). The 4 open PRs were checked for state and
mergeability, all 9 `docs/plans/` documents were verified against code, the Mapbox gap
matrix and the CI job matrix were re-read, and the last week's ~40 merged PRs were grouped
into workstreams. Statuses are as-verified on 2026-08-10. "possibly-done" means landing
evidence exists on main but close-out verification is still owed — an issue is not closed
until the bookkeeping pass records the landing (commit + file:line) on it.

---

## 1. Where the engine stands

- **Language/runtime:** the composer-seam epic (#1605) completed 2026-08-10 (#1642):
  feature-free `@color`/`@stroke` stage blocks compile and render on **both** backends.
  `input` host contracts (#1539) and stdlib self-hosting (#1540) landed.
- **Mapbox style-spec:** 195 supported / 16 partial / 17 unsupported / 15 n-a of 243 rows;
  the "high-impact unsupported" table is empty.
- **Stability:** the 2026-08-03 audit campaign (#1553, 63 findings → 18 issues) has
  essentially executed — device-lost, worker-death, tile-retry, glyph-failure and loader
  error paths hardened (#1584–#1613 series).
- **WebGL2:** the hand-written twin frame is deleted (#1544, #1046 Inc-F3a); one unified
  RHI pass chain drives both backends. New render gates are authored against the RHI
  chain only.
- **Verification asymmetry (constrains every wave):** CI renders WebGL2 via SwiftShader;
  WebGPU has **no** software adapter — WebGPU-only verification is an owner-hardware queue
  (§8), never a reason to skip the WebGL2 half (§5).
- Root `ROADMAP.md` is an early blueprint, not a status tracker: phases 0–2 essentially
  done; 3/4/5/6 partial (~55/30/40/45%); 7 early. This document is the current
  remaining-work authority.

## 2. The backlog at a glance

The 98 open issues decompose into:

| Bucket                                           | Count                   | Where        |
| ------------------------------------------------ | ----------------------- | ------------ |
| In-flight PRs to land/adjudicate                 | 3 (#1604, #1422, #1470) | §3           |
| Bookkeeping-only (possibly-done, close-out owed) | ~17                     | §9           |
| Owner decisions (block their items)              | ~10                     | §8           |
| Owner hardware / real device required            | ~8                      | §8           |
| Real remaining work                              | ~60                     | §3–§7 tracks |

---

## 3. Wave 0 — verification health + in-flight work (start immediately)

Until the render-gate battery is trustworthy, nothing downstream can claim CI evidence
(the #1553 campaign's own sequencing rule). `_adaptive-quality-ladder-gate` is **red on
main**, poisoning §5 verification repo-wide — it goes first.

| #    | Item                                                                                                                                                                                                                                                                                                                                                                      | Why now                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| W0-1 | **#1444 (P0)** — controller steps to notch 1 but the far-field selector ignores it (adaptive settles at 28794 vs control 20008, deterministic since the #1440 FOV window; suspect: notch→`farTargetBoost` wire, `tile-selection-cache.ts:514/793`). Fold #1463's convergence-predicate sampling half into the same home.                                                  | Red gate on main; every PR inherits it.                 |
| W0-2 | **PR #1604** (#1602 drape overlap = relevance, not re-arm recency) — mergeable_state `dirty` after base PR #1589 merged; rebase, add the specified unit + overlap render gates, green.                                                                                                                                                                                    | The one active coverage fix; #1500 closes behind it.    |
| W0-3 | **PR #1422** (#1364 source-error phase / #1355 byte telemetry / #1356 link-cost shaping + the ne_50m fixtures that unblock #1349 step 1) — 34 files, stale since 07-28; merge main in, adjudicate its red leg against the _fetched_ base (§12), re-verify, ready.                                                                                                         | One PR advances four issues.                            |
| W0-4 | **#1635 (P0)** — `zoom` inside `@color`/`@stroke` stage blocks silently compiles to literal 0.0 (`wgsl-expr.ts` field collector excludes `zoom`; `?? f32Lit(0)` always fires). Give `zoom` a real per-frame uniform lane following the InputRef precedent (`wgsl-expr.ts:100-109`); fail-before gate already written (`_stage-block-line-webgl2-gate.spec.ts` R-channel). | Silent miscompile in the just-shipped flagship feature. |
| W0-5 | **Bookkeeping sweep** — §9's close/refresh list, verified before closing.                                                                                                                                                                                                                                                                                                 | Stops future sessions re-deriving landed work (§9.5).   |
| W0-6 | **PR #1470** (draft, stale since 07-29, #1468) — adjudicate against landed #1457: refresh or close.                                                                                                                                                                                                                                                                       | Kill stale in-flight state.                             |

## 4. Wave 1 — correctness & failure-path completion

- **#1364 family extension** (after PR #1422): extend the `source` error phase to
  raster/DEM tiles (reason currently destroyed at `tile-select.ts:687-697`) and sprite
  sheets; fix the `setSourceData` destroy-before-attach ordering. Design the public
  `XGISMapErrorPhase` union **once** with #1599's GPU-fault phase.
- **#1596** — terminal state for permanently-unfetchable tiles so `missedTiles` can reach 0
  and `idle` fires; run the cheap failed-fetcher-vs-404 probe first; tombstone policy
  coordinates with #1269 (UX half). Gate via `keepLoopWarm` (unit-testable, no GPU).
- **#1448 → #1420** — fix stale geometry persisting after `setSourceData` (2.3–3.5× pushed
  geometry until a second push), _then_ give `_reseed-data-push-gate` a real settle
  predicate. Do **not** relax the 0.2 threshold (decided).
- **#1322 (P0 for the label track)** — local PMTiles line-symbol fixture, option (b) only
  (the only option exercising the tiled `tileEntryM` path); then `_line-label-*-gate`
  specs. Unblocks #1321 residuals, INC-4 revival, #777 IV3-b. Shared `.pmtiles` fixture
  want with #1349.
- **#1321 residuals** (after #1322): cross-tile dedup winner-jump (`lineCollisionId`),
  unphased inline raw-GeoJSON path (`place-labels-along-line.ts:483`), INC-2's
  z16.7/pitch-60 coverage regression. Do not retry INC-4 without a new valid witness.
- **#1515** — run the specified separating measurement (count `compact()` calls vs stall
  timing), then bound/amortize arena compaction without reintroducing the UAF that
  `invalidateAll()` guards. §8 rule: a freeze report owes a fix.
- **Raster refetch storm** — file the bug from #1269's audit finding (raster tiles have no
  retry policy and no negative cache; a failed still-visible tile is re-requested every
  frame), plus follow-ups: backoff jitter, single retry authority across the three
  per-source policies.
- **#1349** — wire the count-based leak specs into CI individually; bucket temporal specs
  into nightly/real-GPU by measured SwiftShader cost; per-source liveness assertions
  (`missedTiles` reads 0 on a dead scene).

## 5. Wave 2 — user-visible capability parity

**WebGL2 (the two big visible gaps):**

- **#1592** — data-driven fills render blank on WebGL2 (pipeline-factory early-returns;
  palette atlas never uploaded). Answer the four recorded design questions first (issue
  leans CPU-bake reusing `evalPerFeatureColor`; no storage buffers on GL2); #1583's
  blank+warning gate is the fail-before witness and must flip. Register
  `_stage-block-parity.spec.ts` in `test.yml` (currently runs nowhere).
- **#1056** — 3D extrusion invisible and unclickable on WebGL2; port the extruded path to
  the unified RHI chain (adjudicated: rides #1046, not a twin-side port), OIT answer on
  GL2 (`EXT_color_buffer_float`, r16float precedent), extend `pickViaRhi`.
- **#1480** — verify frame bookkeeping advances under `?forcegl2=1`, add the frame-count
  gate, close with #1046 attribution.

**Labels/text:**

- **#1434** — scale-aware invalidation for the ±0.15 zoom-tolerant prepare skip
  (`label-pass.ts:756-799`); gate the cache-HIT side too (tolerance is load-bearing).
- **#1435** — sounding numerals draw zero on globe/azimuthal: fix
  `unprojectToLonLat`-null-for-projTypes-3/4/5/7 **at the source** (the same constraint
  blocks #777 IV3's pitch0-unproject) keeping ONE selection authority; horizon/backface
  test required.

**Coverage/S-100:**

- **#1499** — IBFV trail animates only the first resident region: per-region ping-pong
  pairs + per-fragment region selection; coordinate with the #1450/#1418 portrayal
  endpoint so streaks aren't reworked twice.
- **#1505** cross-cell half — "concurrent read, sequential arm" with a bounded read-ahead
  window in `syncCoverageResidency` (`coverage-source.ts:393`), preserving the two pinned
  residency invariants. Worth ~1.5–1.8×.
- **#1504 / #1500** — one §5 visual pass on s102-live post-#1503; write the overlap rule
  down + probe-point identity gate once #1604 merges.

**NOAA (public-demo lane):**

- **#1273 GFS GRIB2 wind (flagship)** — GRIB2 reader (simple packing) behind
  `readCoverage`'s extension dispatch + global vector-field rendering (antimeridian, poles,
  10⁵ particles). GFS bucket is CORS-open: the proxy-free public live demo. SCAROW arrows
  suffice for v1 (#1551 not needed).
- **#1274 SST (quick win)** — OISST is NetCDF-4 (= HDF5): `.nc` dispatch + CF-name shim to
  the existing reader + an SST perceptual ramp + gate.
- **#1275** — item 3 first (api.weather.gov GeoJSON, CORS *), GOES after tiled-endpoint
  confirmation; item 1 stays blocked on the WMS→XYZ adapter (#1478).

## 6. Wave 3 — performance & scale

- **#1190 (the scalability epic)** — lever 1: render-bundle replay correctness + the
  double-walk, re-enable (or scope to camera-idle) under the full §5 ladder (last enable
  shipped an empty-canvas regression); lever 2: world-copy instancing (`pick_id` reserves
  instanceId bits); then draw merging. Encode wall measured: ~0.5ms/layer, 16ms at ~35
  layers.
- **#1177 tier 2** — world/Mercator-space label anchors reprojected per frame in the
  shader (exact for every projection incl. globe); touches vertex layout, curved labels,
  collision bookkeeping. The real fix behind #1434/#1507-class symptoms.
- **#1375 (absorb #1283)** — in-place declared-source feature update: patch packed
  geometry, no teardown/re-tile (graphics batches prove feasibility). Everything smaller
  is done or deliberately declined.
- **#1488** — prewarm-reorder variant only (move the shader-prewarm await below
  rebuildLayers + arm); the extraction approach was measured at zero win and the ratchet
  correctly refuses it unless folded into a net reduction.
- **#1632** — per-show pack memo requires per-show buffer sets: a GPU-memory decision, then
  the createBuffer-count witness; re-sever the #1616 gate after.
- **#1155 residual** — owner call on the `.xgb v3` re-scope; re-measure TTFM on real
  hardware.

## 7. Wave 4 — platform & long-horizon epics

- **#991 map→engine** — A2 next (P5 render-graph scheduler + FullscreenComposePass +
  bakeToTexture → unblocks #599 globe vector drape), then A3 (~150 raw pipeline sites),
  A4 (P3 ∥ P7 ∥ P8), A5 (FrameUniform authority). Success metric: raw-WebGPU baseline → {}.
- **#1506** — Projection value object owned by the camera; retire bare `projType: number`
  (~500 sites); fix the #996 path-keyed-ratchet hazard alongside.
- **#1152 INC-3/INC-4 → #1161 S-101** — ellipsoid surface grid/focus/horizon in WGSL
  (df64, real-GPU verify), retire sphere helpers; then S-101 INC-1 (one lighthouse)
  through INC-7 with user-build-time atlas generation (PC licence: no redistribution).
- **#777 tail** — Phase I order I-A → I-C (pair with IV3) → I-E → I-G (last, never
  concurrent with I-A); Phase III expression finishes; IV3-b line-placed ground alignment
  (settle the per-label vs per-glyph basis fork FIRST, land the observable before the
  feature; text-stage.ts is AT its LOC ceiling — extraction tax due); Phases IV/V; D-phase
  reclassify.
- **#1192 gallery** — portable-now clusters (symbols/labels); gap-gated rows close 1:1
  with their feature issues (#1267 RTL, #1258 atmosphere, #1264/#1265 gestures, …);
  working agreement: a feature PR ships its ported example.
- **Language tail** — #1069 slice 1 early (unhandled modifier = error instead of silent
  drop — cheap, fixes the spec-doc lie), then the feature-state store + #1070 (registry
  slice first; the cubic-bezier/spring runtime primitive is solved ONCE with the converter
  densifier); #1073 CLI (`fmt`/`convert`/bin) + LSP fed by the 96-def registry;
  #1303 JSON loader (seam landed); #1304 `refresh:` (settle coverage semantics in-issue
  first). #1543 v4 stays research-gated behind v3.
- **UX/interaction parity** — #1264 cooperativeGestures, #1265 dblclick/box zoom (#1256
  prereq landed — ease from the start), #1258 atmosphere Phase 1 (named the single largest
  Google-Earth-grade visual upgrade; default byte-identical), #1259 projection morph,
  #1266 strictly behind #1265.
- **#797 drawing API** — Phase-1 GPU benchmark first (owner hardware), then Phases 2–5 +
  the approved vertical-datum design (LngLat carries Z; `altitudeMode`; providers declare
  datum).
- **#1484** — go/no-go on the closed-set shader bake (golden-sync gate is the whole risk).
- **#1543 v4** — after v3: axis 1 (reference evaluator) → axis 2 A→B→C → axis 3;
  `xgisc explain` is cheap anytime.

## 8. Standing queues

### Owner decisions (each blocks its item; leans are the investigators' on-record leans)

| Issue | Decision                                                                  | Recorded options / lean                                    |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| #1522 | slerp→linear interpolation flip (reverses a documented design choice)     | lean linear (MapLibre parity); fix otherwise proven, small |
| #1450 | arrow/flow portrayal endpoint                                             | lean option 1: one portrayal, two generators               |
| #1418 | `flow` default                                                            | arrows (breaking visual) vs streaks (compatible)           |
| #834  | M5 context-family home; M-B6 residue shape; M-B7 composition root         | 3 recorded options for M5                                  |
| #1592 | per-feature fill on GL2: CPU bake vs uber-shader; expression-parity scope | issue leans CPU bake                                       |
| #1640 | ofm_bright_local asset                                                    | drop demo (cheapest) / commit mirror / live origin         |
| #1296 | deployed-site CORS story                                                  | host Range proxy / NOAA CORS / lean on GFS-GOES lanes      |
| #1155 | `.xgb` v3 full-fidelity re-scope                                          | go/no-go                                                   |
| #1201 | §6.5-vs-§1/§9 autonomy conflict                                           | narrow or close as overtaken by §9.5                       |
| #1615 | caps-to-load-time-singleton                                               | lean option 3 (wontfix-unless-observed)                    |

### Owner hardware (batch into ONE real-GPU session)

#1508 (two dismissable-or-P0 reports), #1623 final WebGPU check, #1189 P0b parity gate +
default flip, #1429 pending view + close, #1152 INC-3 df64 battery, #797 Phase-1 100k-icon
benchmark, #1302 render verify + close, #1507 real-device mobile profile.

### Reporter/user confirmations

#1510 (S-111 Live holes), #1504 (ramp visual confirm).

## 9. Bookkeeping sweep (verify on main FIRST, then record commit + file:line, then act)

**Close after recording the landing:** #1575 (#1595), #1576 (#1600), #1367 (+ fix stale
`_perf-pitch-cost-sweep` header; residual lives in #1393), #1063 (census denominator —
the twin — is deleted; absorb #1592 as a row or close), #1284 (confirm 4d/5 via
opendata-bridge + catalogue), #1501 (pure index), #826 (verify FlowRenderer/#1424 covers
the ask), #1194 (A-series complete; file B-series fresh).

**Refresh stale bodies/trackers:** #834 (post-#1046/#1544 reality), #777 (census +
IV3-a done), #1321 (link the plan doc; retitle to residuals), #1074 (tick items 1-5, 8,
9), #1553 + #1359 (adjudicate checklists against #1584–#1613; close #1359 into #1553),
#1158 (re-scope without `.xgcov` or close into #1271/#1284), #1271 (ADR-0010 language),
#830 (re-audit A/C tracks; B-track is the critical path), #1153 (re-adjudicate the 33-row
table against HEAD before dispatching anything), #1257 (record the landed fade; residual =
paint property + three-way row sync + frame-clock note → #1477).

## 10. Constraints to carry forward (do not rediscover)

- Design the error-phase union once (#1364 + #1599).
- `unprojectToLonLat` null on projTypes 3/4/5/7: one fix serves #1435 and #777 IV3.
- `text-stage.ts` and `camera.ts` are AT their LOC ceilings — label/camera work pays the
  extraction tax first.
- ADR-0010 is law: read standards in place; no converters, no house blobs.
- The frame-0 arrow parity contract was deliberately ended; no density hysteresis.
- #1194's builder surface is NOT derived from the binding registry (decided).
- One easing runtime primitive for #1070 + the converter densifier.
- A `.pmtiles` fixture serves both #1322 and #1349 — build it once.
- `_prefersReducedMotion()` is the single reduced-motion authority (#1264/#1265/#1266/#1259).
- Author all new render gates against the unified RHI chain (the twin is gone).

## 11. Delegation model

Implementation is delegated to Claude Opus sessions — one issue (or one in-flight PR) per
session, each session: issue-first (§9.5), full gate (§11: build + vitest + precheck +
tsc), §5 render evidence (SwiftShader WebGL2, full-resolution reads), root cause recorded
at file:line on the issue (§8), draft PR. Merges to main go through the pr-merge-gauntlet
after CI is green. Wave 0 sessions dispatched 2026-08-10: W0-1 (#1444), W0-2 (PR #1604),
W0-3 (PR #1422), W0-4 (#1635), W0-5 (bookkeeping sweep).

---

## 12. Addendum — status refresh as of 2026-08-17

Everything above is the 2026-08-10 snapshot. This section records the week's delta
(52 merges 08-11→08-17, 46 issues opened of which 38 closed in-week) and corrects what
it falsified. Method as §0: merged-PR delta and issue churn surveyed and mapped to the
tracks above.

### 12.1 Wave 0 outcome

| Item               | Outcome                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0-1 (#1444)       | The reported notch→selector defect **does not reproduce** on main — the gate is green and the wire intact; §3's "red on main" premise was stale. Deliverable became gate **attribution** hardening (each severed half names itself; backend pinned per arm). PR #1644 closed unmerged → superseded by **#1752**.     |
| W0-2 (#1602)       | PR #1604 was merged by the owner minutes before dispatch; the session pivoted to the #1500 close-out (ADR-0011 + three-authority probe-point identity gate). PR #1646 closed unmerged → superseded by **#1751**. #1602 is closed.                                                                                    |
| W0-3 (PR #1422)    | Revived: conflicts resolved, full CI green at the 08-10 head **including render-gate** — the PR body's "#1479 red leg" note is stale. Went dirty again against this week's main; a second merge-in landed 08-17 (measured ratchet unions: vector-tile-renderer.ts 4919, map.ts 5434, layer.ts 813).                  |
| W0-4 (#1635)       | Fix implemented (`u.zoom` uniform lane). PR #1645 closed unmerged → superseded by **#1747**. The miscompile is **still live on main** as of 08-17 — this remains the open P0.                                                                                                                                        |
| W0-5 (bookkeeping) | Executed in-session but **zero GitHub writes landed** — child sessions lack GitHub App auth (they can push branches; they cannot create PRs or write issues). §9's sweep is still owed in full. Process rule for future delegation: the dispatching session or an enabled GitHub App must perform the GitHub writes. |

### 12.2 Landed 08-11 → 08-17, by track

- **#1592 (Wave 2 headline) partially landed** via #1655 (+ #1663/#1668/#1669 follow-ups):
  WebGL2 per-feature fills paint; the compute-routed residue stays open. The landing shape
  was **neither §8 option** (CPU bake vs uber-shader): per-variant Material + per-tile
  `feat_data` over the GLSL storage→data-texture lowering (#1647). That §8 row is consumed.
- **#1484 decided GO and executed**: bake phase A (#1680 — committed artifact, 106-key
  hash-equality gates), baked-shader store + git-subtree mirror (#1682/#1687), phase B
  boot families (#1679 series). Companion **decision #1690**: production shader emit will
  NOT be wired into the map build (measured gzip + driver-compile cost) — cite it before
  proposing runtime emit. That §8 row is consumed too.
- **#1468 closed**; stale draft PR #1470 closed unmerged and adopted as **#1753** (W0-6 done).

### 12.3 New workstreams the 08-10 survey did not contain

- **shader-dsl GLSL/WebGL2 capability parity sprint**, driven by an external consumer
  (dc4i.js — 29 GLSL programs inside MapLibre GL): ~25 issues opened and closed in-week
  (texture phases A/B/C incl. integer sampled textures, extension profiles, rawGlsl,
  fail-closed absent builtins, mediump policy, production minify emit, emitGuardedFragment).
- **shader-dsl host-boundary APIs** (#1710–#1717): emitFragment, externVar, hostUniform,
  variantFamily, buildRegistry, capabilityMatrix, semanticDiff, hostBlock.
- **Packaging-readiness cluster (open)**: #1681 publishable shader-dsl (the active epic),
  #1685 (@xgis/map tarball ships no entry point), #1686 (bundler-only specifiers).
- **Docs/API-reference pipeline (open)**: #1694/#1695/#1697/#1700; the doc-coverage
  allowlist reached zero (#1727) and /api is generated (#1699).
- **Dark-gate lighting**: §5's "one unregistered spec" note was understated — 34+ gate
  specs ran in NO CI leg (#1715). Now bounded by a shrink-only ratchet (#1723) and lit
  individually (#1729/#1736–#1744); one dark gate had been hiding a real live defect
  (#1728: a re-seed through an empty collection permanently stops a source re-tiling,
  live since #1371, fixed by #1737).
- **Repo DX**: changelog automation (#1653/#1709), bulk-demo-data fetch policy
  (#1730/#1734 — likely overtakes §8's #1640 decision row; PR #1750 is in flight),
  §12 lesson additions (#1718), e2e specs still un-typechecked (#1683, open).

### 12.4 The now-queue as of 2026-08-17

1. **Land the 08-17 draft batch** (re-spun on current main): #1747 (#1635 — the open P0),
   #1746 (#1599), #1748 (#1632), #1749 (#1596), #1750 (#1640), #1751 (#1500),
   #1752 (#1444), #1753 (#1468 adoption).
2. **Land PR #1422** (second main merge-in done 08-17) — advances #1364/#1355/#1356 and
   unblocks #1349 step 1.
3. **Execute the §9 bookkeeping sweep** — still owed in full (see 12.1 W0-5).
4. Then **Wave 1 continues as written** (§4), minus the items already in the draft batch;
   the packaging + docs clusters (12.3) slot alongside Wave 4 as the new ecosystem track.
