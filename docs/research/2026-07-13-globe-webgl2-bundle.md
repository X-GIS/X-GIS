# Globe/WebGL2 defect bundle — root causes, fixes, and method (2026-07-13)

Session record for PR #1048 (branch `claude/fix-globe-webgl2`). User-reported defects on the
globe projection under WebGL2, reproduced headlessly (SwiftShader) with WebGPU as the
reference frame at identical cameras. All four root causes were **twin-frame-only** — the
WebGPU frame was correct at the same cameras — which is the empirical backbone of #1046
(eliminate the twin frame; capability queries over backend identity).

## Root causes (all confirmed by construction, file:line)

| Issue                               | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1044 raster↔vector misregistration | The WebGL2 twin packs (`renderFillsRhi`/`renderLinesRhi`) hard-zeroed the `cam_ecef_off_{h,l}` DSFUN lanes, so on the globe every vector vertex reconstructed against the wrong ECEF origin — the whole vector layer drew at a displaced transform.                                                                                                                                                                                      | Single anchor authority `map/src/render/tile-camera-anchor.ts` (Mercator DSFUN rel + ellipsoid ECEF RTC, worldOff on Mercator only); all four packs route through it; drift guard `tile-camera-anchor-authority.test.ts` (lane-exact parity incl. the ellipsoid-CAMERA-term guard: sphere camera shifts offZ ~20.7 km at Tokyo z14 while a full-sphere E2→0 cancels to ~0.7 m in the RTC difference — the guard must isolate the camera term). |
| #1041 checkerboard background       | `render-loop.ts` drew the US-003/US-004 analytic checker as the _else_ of `hasSource()` — production-reachable because the default provider chain auto-falls back to WebGL2; WebGPU draws nothing sourceless (`render()` early-returns).                                                                                                                                                                                                 | Sourceless frame draws nothing; checker opt-in via `?debug=checker` (`DEBUG_RHI_CHECKER`, debug-flags pattern); the two e2e gates calibrated on the checker boot with the flag.                                                                                                                                                                                                                                                                |
| #1040 ~16-gon globe silhouette      | The raster surface mesh is procedural (`vs_tile`), and its grid was a compile-time literal 8×8 with a duplicated draw count 384 — a z0 whole-world tile got the same 8×8 as a z18 tile. Same defect class as userbug 09 (vector earth-surface fixed at 32×16 → 128×64), never ported.                                                                                                                                                    | `rasterGridN(projType, tileZoom)` ladder (globe: `128 >> z` clamped [8,128]; flat unchanged), N threaded per tile via the former `_pad` uniform lane (renamed `grid`), count derived via `rasterGridVertexCount`. Membership via `isGlobeProj` (projType-confinement ratchet #996). Pole cap above ±85.05° deliberately out of scope → #1053.                                                                                                  |
| #1043 WebGL2 flicker                | `setPipeline` re-sets its state unconditionally per bind, so leaks live in the clears/dispatches: `beginScreenPass` never unmasked `colorMask` before the colour clear (glClear honors write masks — the unfixed colour sibling of #780/#746; all-false masks are real shapes: stencil-only clip, writeMask-0 pick); `dispatchComputeToR32UI` leaked `gl.viewport`; the no-depth `setPipeline` arm never disabled `POLYGON_OFFSET_FILL`. | Unmask-before-clear for colour (mirrors `beginOffscreenPass:628`), viewport snapshot+restore in the `finally`, polygon-offset disable in the no-depth arm. Fail-before fake-GL test for the colour unmask. Static parity gaps (wrong shape for flicker) split to #1049.                                                                                                                                                                        |

## #1042 (labels off-globe): premise refuted, probe pending

The suspected "missing far-side containment" does NOT exist — the label projector culls with
the exact tangent-cone test (`render-loop-helpers.ts:330-346`), shared formula with the tile
selector and `globeEyeUniform`. Real candidates: line-label chord-jump across culled vertices
(#1050 — confirmed structural defect), ortho-telephoto (×96) matrix extremes + the untested
pitch 60–85° band (#1051). The label pass is backend-shared (`labelPass.execute` called by
both frames), so the bug reproduces on both backends. Probe classification pending.

## Verification method (keep for future parity work)

- Headless SwiftShader: `HEADED=0 XGIS_SOFTWARE_GPU=1 XGIS_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`,
  `bunx playwright test` from `playground/`; demo URL controls camera
  (`?id=&backend=&e2e=1&proj=globe#zoom/lat/lon/bearing/pitch`), readiness via
  `window.__xgisReady` / `__xgisActiveBackend`.
- §5 directional gates, never absolute-% eyeballing: before/after DC > 0 on the changed
  backend, D1 < D0 vs the reference backend at identical cameras, and DC ≈ 0 on the
  reference backend (refactor-neutrality check). Read the diff image in a 4×4 grid at full
  resolution plus a ×5 crop of the hottest region.
- Cross-instrument network claims (page.route AND CDP) before believing counts — a
  double-registered handler fabricated a "93 duplicate requests" finding in the #1045 work.

## Registered follow-ups

#1049 (rhi-webgl2 descriptor parity umbrella), #1050 (chord-jump), #1051 (label coverage
gaps), #1052 (front-hemisphere test consolidation), #1053 (raster pole cap), #1054
(engine-content-split.md staleness), #1055 (repo lint debt incl. vitest.config.ts project-service
parse error).
