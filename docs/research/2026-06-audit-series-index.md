# X-GIS runtime audit series — index & cross-cutting synthesis

*2026-06-08. Ten deep-research + codebase audits of the X-GIS runtime, each combining web-researched principles (cited) with a direct file:line audit. This index ties them together: the recurring patterns across all ten, and a single prioritized master fix list. Each audit is a standalone doc; this is the map.*

## The ten audits
| # | Audit | Doc | Headline finding |
|---|---|---|---|
| ① | Async / concurrency / staleness | `2026-06-audit-async-concurrency.md` | Async resource-landing (glyph PBF `onLanded`, sprite atlas, raster) never re-arms `_needsRender` → stale frames after an S16 skip. S16 was systemic. |
| ② | Tile pipeline & GPU memory | `2026-06-audit-tile-pipeline-gpu-memory.md` | Real GPU leak (glyph atlas pages never shrink); cache thrash (selection unbounded vs 256 cap; MapLibre sizes at 5× viewport). |
| ③ | Test strategy & coverage | `2026-06-audit-test-strategy.md` | Strategy is sound (CPU oracles + real-GPU last resort); gaps are what SwiftShader can't reach — OIT & extrude depth have *zero* correctness coverage. |
| ④ | Label / text | `2026-06-audit-label-text.md` | Live bug: 32-bit layout-cache hash collision returns another label's glyph offsets; generation guard checks the wrong invariant. No cross-tile symbol index. |
| ⑤ | Compiler ↔ runtime contract | `2026-06-audit-compiler-runtime-contract.md` | `ShowCommand` defined twice (no shared type); expr crosses as `{ast: unknown}` + `as unknown as RuntimeExpr`; no version field. |
| ⑥ | Numerical precision | `2026-06-audit-numerical-precision.md` | Deep-zoom non-Mercator f32 drift is *fundamental* (MapLibre switches globe→Mercator at z12 for the same reason); DSFUN "naming drift" is cosmetic. |
| ⑦ | OIT / compositing | `2026-06-audit-oit-compositing.md` | OIT is hardcoded OFF + architecturally incomplete (dead code); translucent extrusions composite order-*dependently* today. |
| ⑧ | Error / device-loss / observability | `2026-06-audit-error-device-loss.md` | Device loss detected but **no recovery** (fatal); validation-error rejections swallowed; no map `'error'` event. |
| ⑨ | Performance / frame budget | `2026-06-audit-performance.md` | Mature perf system; risks are specific stalls — mobile `buildLineSegments` on render thread, high-pitch compile convergence (~60 frames). |
| ⑩ | Input / camera / picking | `2026-06-audit-input-camera-picking.md` | Picking ignores layer visibility; pick coord `Math.floor` bias at DPR≥2; unproject-above-horizon → broken delta-pan; pinch-rotate has no dead-zone. |

## Cross-cutting patterns (the same root causes, many faces)

**P1 — "Detect/produce, but the signal never reaches the actor."** The single most common defect class.
- Async resource lands but never re-arms the frame loop (① B1-5).
- Device loss is *detected* but never *recovered* (⑧ B1).
- A failure is *logged* (`console.error`) but never *surfaced* as an event an app can act on (⑧ B3/B5).
- OIT is *built* but never *routed* (⑦ B1).
The reference engines all close this loop explicitly: MapLibre's `_afterImageUpdated → data event → _update → frame`, its `map.on('error')`, the WebGPU device-loss rebuild contract. **The fix theme: every produce/detect must connect to its consumer — a dirty flag + scheduled frame, an event, or a rebuild.**

**P2 — "Validated ≠ correct" (the guard checks the wrong invariant).**
- The layout-cache generation guard validates eviction-staleness, not *text identity*, so a hash collision slips through (④ B1).
- Picking filters visibility in the *render* pass, not the *pick* pass (⑩ B1).
- Validation error scopes are *popped* but the rejection is `.catch(()=>{})` (⑧ B2).
- The compiler↔runtime parity test validates intra-compiler IR→WGSL, not the cross-boundary cast (⑤ B4).

**P3 — Implicit contracts with no compile-time enforcement.**
- Premultiplication convention (3 of them in one file) (⑦ B2); compiler↔runtime `ShowCommand`/expr (⑤ B1/B2); DSFUN naming (⑥ B1). Buffer layout *is* enforced (shader audit) — proving the team knows the pattern; it's just not applied everywhere.

**P4 — Missing reference-engine mechanisms (well-known, not yet adopted).** Cross-tile symbol index (④), pauseable label placement (④/⑨), pinch/rotate dead-zones (⑩), `map.on('error')` (⑧), cache sized at ~5× viewport (②), compile worker pool (⑨). Each is a documented MapLibre/Mapbox/deck.gl solution.

**P5 — Fundamental limits, correctly tracked (not bugs).** Deep-zoom f32 (⑥, MapLibre precedent), sRGB-space blending (deliberate, ⑦/#3), real-GPU-only testing for rasterization (③). The right posture here is acceptance + documentation, not chasing.

## Master prioritized fix list (cheap × high-value first)
**Tier 1 — minutes to a few lines, high signal:**
1. Un-swallow validation-error rejections — delete `.catch(()=>{})` (⑧ B2).
2. Glyph-PBF `onLanded` → tag dirty / re-arm `_needsRender` (① B1) — fixes visible label freeze.
3. Pick pass visibility filter (⑩ B1) — invisible⇒unclickable.
4. Layout-cache text-identity check on hit (④ B1) — kills the scatter corruption.
5. `expected_red`-flip alert (③ E) — surface silent fix/regression of 7 tracked bugs.
6. Center-round pick coords at DPR≥2 (⑩ B2).

**Tier 2 — small, structural:**
7. Compile every polygon *variant* in the existing `_wgsl-compile-gate` (③ D3).
8. Premultiplication-convention compile check (⑦ B2).
9. Add a map `'error'` event + route worker/OOM into it (⑧ B3/B5).
10. Pinch-rotate dead-zone (⑩ B4); cancel inertia on pointerdown (⑩ B6).
11. Pre-size uniform ring; glyph-atlas page reclaim; destroy-on-realloc (② B1/B3, ⑨ B3).
12. DSFUN cross-shader parity test (⑥ B1).

**Tier 3 — larger, decide/design:**
13. **Decide OIT's fate** — complete+test the routing (with depth-ordering oracle #4b + reversed-Z #4) or delete the dead code (⑦ B1, ③ D1).
14. Device-loss recovery loop (⑧ B1) — fully specified, mechanical.
15. Share the compiler↔runtime type + schema-validate at ingestion + version stamp (⑤ B1-3).
16. Mobile `buildLineSegments` worker + compile worker pool (⑨ B1/B2).
17. Cross-tile symbol index + pauseable placement (④ C, ⑨ B4).

**Already queued (desktop, separate plan):** azi/stereo cap #2, reversed-Z + [0,1] depth #4, depth-ordering oracle #4b — see `2026-06-desktop-rendering-fixes.md`.

## How to read the series
Each audit doc is self-contained: TL;DR → architecture → numbered findings (file:line, severity) → what's robust → ranked fixes → cited sources (confidence flagged). The web-researched principles are cited inline; the codebase findings are first-hand file:line. Where audits interact (e.g. #4b depth oracle spans ③/⑦; uniform-ring spans ②/⑨; async-landing spans ①/④/⑧) the docs cross-reference.
