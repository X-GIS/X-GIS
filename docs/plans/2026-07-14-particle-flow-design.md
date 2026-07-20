# Particle-flow vector-field mode — the wind-map aesthetic as a sibling of the retained arrow (#826)

Design document (no production code) for adding an ANIMATED particle-flow representation of
movement — particles drifting along the per-gu outflow field, density proportional to volume,
the earth.nullschool / Mapbox-wind aesthetic — as an OPTION alongside the static arrows that
landed in `e363f4b0` (#824). Both representations are driven by the SAME per-gu field the
`seoul-arc-multiday` demo already computes (`playground/src/seoul-arc-multiday.ts:190-213`);
particle-flow is a second reading of that one field, not a second data path.

Empirical backbone: the static arrow primitive already proves the whole retained, geo-anchored,
GPU-projected, N-independent, dual-backend batch machinery works end-to-end
(`map/src/graphics/graphics-manager.ts:307-384` render, `map/src/render/material/arrow-retained-material.ts:68-84`
draw, GLSL twin at `map/src/shaders/dsl/arrow-retained.ts:263-271`). Particle-flow is the
smallest possible delta on that proven spine: a new instanced primitive whose per-instance
position is a function of a per-frame TIME uniform. This document's core claim is that the
twin-kill-friendly, verified-by-construction way to build it is a STATELESS vertex-shader
integration (candidate **b**), and that compute-pass advection (candidate **a**) is a
`caps.compute === 'native'`-gated enhancement for a scale Seoul does not reach — never the
baseline, because the WebGL2 arm cannot honestly carry it (§3.1, §4.2).

Lands under epic #830 (서울 생활이동 flow-map production), item A/#826. Constrained by #1046: any new
pipeline is dual-source DSL or capability-gated, never a backend-identity fork
(`docs/plans/2026-07-14-twin-frame-elimination.md:486-507`). Held to #797's perf-honesty bar:
every scale claim is tied to a named existing batch seam (#797 body; the arrow's draw-call
N-independence gate at `map/src/graphics/graphics-manager.ts:90-98`).

Scope guard: this adds ONE new retained primitive (`type: 'particle-flow'`) and the per-frame
animation-clock seam it needs. It is NOT a general particle system, NOT per-particle collision,
NOT a new renderer, and it does NOT touch the arrow, icon, or circle paths beyond one
`spec.type` branch (the existing dispatch pattern, `graphics-manager.ts:189-244`). §4.5 is the
explicit Cut list.

---

## 1. Problem and the wind-map aesthetic target

### 1.1 What the wind-map aesthetic is, precisely

The static arrow answers "which way, how much" at a fixed anchor: one oriented glyph per gu,
length ∝ √volume, bearing = outflow direction (`seoul-arc-multiday.ts:306-314`). It is legible
but frozen — motion is implied, never shown. The particle-flow mode answers the same question
with MOTION: many small particles are seeded across each gu and drift along that gu's outflow
direction; the eye integrates the moving dots into a sense of current. Two visual invariants
define "correct" here:

1. **Density ∝ volume.** A high-outflow gu (a job centre in the AM, a residential gu in the PM)
   carries visibly MORE particles per unit area than a quiet gu. This is the load-bearing
   difference from the arrow, whose volume channel is glyph LENGTH, not count. Density is the
   honest visual encoding of volume for a flow field (it is what wind maps use).
2. **Drift along the field.** Each particle's velocity is the local outflow direction
   (`fx` east, `fy` north, `seoul-arc-multiday.ts:131-133`); particles fade in, drift for a
   bounded lifetime, fade out, and respawn — so the field breathes without particles escaping
   their gu or accumulating at edges.

### 1.2 The static sibling — what exists (do not regress it)

The arrow is a first-class retained primitive, authored via `@xgis/shader-dsl`, that:

- projects its geo anchor ON THE GPU so a camera move rewrites only the ~160 B `pointU` frame
  uniform, never the per-instance buffer (`arrow-retained.ts:1-16`, `graphics-manager.ts:307-384`);
- derives its screen orientation from TWO projected geo points (tail + a bearing-step tip), so
  the direction is geographic under any camera/pitch/globe (`arrow-retained.ts:132-165`, #825);
- draws a 6-vertex bounding quad with an analytic arrow SDF in the fragment for
  resolution-independent AA (`arrow-retained.ts:167-244`, #824);
- issues exactly ONE instanced `draw(6, count)` per visible world copy — O(COPIES) draw calls,
  N-independent (`arrow-retained-material.ts:68-84`, the invariant asserted at
  `graphics-manager.ts:90-98`);
- carries a GLSL ES 3.00 twin emitted behind a live `rhi.backend === 'webgl2'` guard, so it runs
  on both backends (`arrow-retained.ts:263-271`, `arrow-retained-material.ts:24-27`, #823).

Particle-flow must be a PEER of this, selected per batch by `spec.type` exactly as circle is
today (`graphics-manager.ts:189-244`), leaving the arrow path byte-identical (the arrow batch's
own gate, e363f4b0: "icon path byte-identical (N-independence 3/3)").

### 1.3 One field, two representations

The design principle: the per-gu field is the single authority; arrows and particles are two
GPU readings of it. An app toggles representation the way `seoul-arc-multiday` already toggles
choropleth net↔activity and arrow outflow↔netflux (`seoul-arc-multiday.ts:380-387`) — a
re-pack of a retained batch, never a re-tile, never a second data pipeline. This is why the
data contract (§2) is stated once and both primitives consume it.

---

## 2. Data contract — the per-gu field

### 2.1 Exact shape

The field the demo computes today, keyed by gu name (`seoul-arc-multiday.ts:131-133,190-213`):

```ts
/** Per-gu outflow: unit screen-bearing components (fx east, fy north) + 0–1 volume proxy. */
type Vec = { fx: number; fy: number; vnorm: number }
type Field = Map<string /* gu name */, Vec> // 25 entries (GU, seoul-arc-multiday.ts:35)
```

- `fx, fy`: the pop-weighted mean OUTFLOW direction, unit-normalised (`m = hypot(vx,vy)`,
  `seoul-arc-multiday.ts:208-211`). Conformal Mercator ⇒ ground bearing = screen bearing,
  invariant to pan/zoom (`seoul-arc-multiday.ts:17-19`).
- `vnorm ∈ [0,1]`: `min(1, sqrt(vol / volMax))` — the arrow's LENGTH channel
  (`seoul-arc-multiday.ts:210`). Note the √ compression: `vnorm` is a PERCEPTUAL length scale,
  not raw volume. Particle DENSITY must key off the raw `vol` (the pre-√ `a.vol`,
  `seoul-arc-multiday.ts:204`), not `vnorm` — else a 4× busier gu shows only 2× the particles.
  This is an open question with a recommended default (§5-Q3).

Per-gu geometry the particle mode also needs (already available):

- Centroid `{lon, lat}` per gu (`seoul-arc-multiday.ts:34`, `CENTROID`).
- Gu polygon (`seoul_gu.geojson`, `seoul-arc-multiday.ts:151-157`) — needed ONLY if particles
  are seeded across the gu AREA rather than jittered around the centroid (§5-Q5).

### 2.2 Size and update cadence

- **Size:** 25 gu. The field is a 25-entry map; the raw OD source is 98,837 flows
  (`seoul-arc-multiday.ts:5`) reduced to the 25-cell field once per hour on the CPU
  (`computeField`, `seoul-arc-multiday.ts:190-213`). The field itself is ~25 × 3 floats = trivial.
- **Update cadence:** the field is recomputed and the batch re-packed on each HOUR change
  (`renderFrame → arrows.update({triggers})`, `seoul-arc-multiday.ts:334-336`), driven by the
  scrubber or the 900 ms autoplay tick (`seoul-arc-multiday.ts:389-404`). This is a DISCRETE,
  low-frequency data update (≤ ~1 Hz) — distinct from the CONTINUOUS animation clock that
  makes particles move every frame (60 Hz). The two must not be conflated: the hour re-pack is
  the existing retained `update()` (O(N) writeBuffer, off the hot path); the per-frame drift is
  the new animation seam (O(1) uniform write, §3).

### 2.3 Deriving N honestly (density ∝ volume)

Particle count per gu ∝ that gu's outflow volume. For a legible field over 25 discrete cells,
each busy cell needs ~10²–10³ particles to read as flow rather than as scattered dots; quiet
cells taper to tens. Seoul's outflow is skewed (a handful of job-centre gu dominate each
rush hour), so with a per-gu allocation `n_i = clamp(N_cap · vol_i / Σvol, n_floor, ·)`:

| Design point                 | N_total      | Rationale                                                                 |
| ---------------------------- | ------------ | ------------------------------------------------------------------------- |
| Legible Seoul field          | ~4,096       | ~160 avg/gu, busiest ~600–800, quiet ~30 — reads as current, not confetti |
| Upper bound (design ceiling) | 16,384 (2¹⁴) | headroom; power-of-two for compute dispatch / texture sizing              |

**Honesty note (the #797 bar):** at N ≈ 4k–16k over 25 cells, Seoul does not stress ANY of the
three architectures — 16k particles is sub-millisecond even on the CPU. So per-frame COST does
not discriminate the candidates at Seoul scale; backend coverage, twin-friendliness, and
deterministic verification do (§3.4). The architecture choice earns its keep only at the
5-year engine scale — a fine grid or national field where N reaches 10⁵–10⁶ — and the doc is
written for THAT horizon, with Seoul as the first, deliberately-easy consumer.

---

## 3. Three candidate architectures

All three place particles in the SAME frame slot as the arrow: the `graphics` pass, which runs
LAST in `PASS_CHAIN_ORDER` (`map/src/render/passes/pass-order.ts:19-29`), single-sample onto
the already-resolved swapchain (`map/src/render/passes/graphics-pass.ts:36-52`), gated OFF when
no host batch exists (`scene.hasGraphics`, `graphics-pass.ts:29-31`, `scene-view.ts:46-49`).
They differ in WHERE the per-frame integration happens.

### 3.0 The one thing all three need: a per-frame animation clock

Today nothing in the retained path advances with time — a camera-only frame rewrites only the
frame uniform and re-runs no accessor (`graphics-manager.ts:307-384`). Particles need a scalar
`t` (seconds) that advances every frame and is readable in the shader. The seam: a small
dedicated frame-uniform field (recommend a sibling `animU`, NOT bloating the shared 160 B
`pointU` that icon/arrow/circle/point all read — §5-Q2), written O(1) per frame inside the
graphics pass right where the per-copy frame uniform is written today
(`graphics-manager.ts:340-363`). This ONE new per-frame write is O(1) in particle count on all
three candidates; it is the only new hot-path cost the baseline introduces.

### 3.1 Candidate (a) — compute-pass particle advection (WebGPU `caps.compute === 'native'`)

**Shape.** A persistent particle-state storage buffer (position, age, seed) is advected by a
compute kernel each frame: read state, sample the gu field, Euler-step the position, age/respawn,
write state. Because a compute pass cannot read and write the same buffer race-free, state is a
PING-PONG pair (A→B this frame, B→A next). The render half then draws instances from the current
state buffer through the graphics pass.

**How it enters the pass chain (#1046).** Compute pre-passes are dispatched in the unified
(WebGPU) frame arm BEFORE the first render pass, so a later fragment/vertex read sees populated
output (`map/src/render-loop.ts:296-303`; `renderer.dispatchComputePass`,
`map/src/render/renderer.ts:314-320`). The existing dispatcher (`rhi-webgpu/src/compute.ts`) is
a STATELESS per-feature map: `feat_data (read)` → `out_color (read_write)`, one output per
feature (`compute.ts:157-171,283-334`) — it has no notion of persistent ping-pong state across
frames. So (a) needs a NEW compute usage (double-buffered `read_write` state that survives
frames), and a decision about ordering: the particle kernel must run in the pre-pass block
(`render-loop.ts:296-303`), which is currently no-op in production ("no variant carries
`computeBindings` today", `render-loop.ts:299-302`). Adding a content-owned kernel there has
pass-order-parity implications — the pre-pass dispatch is part of the frame shell the
`pass-order-parity.test.ts` authority governs; a particle kernel is the first PRODUCTION
consumer of that seam and must be gated so a no-particle map stays byte-identical.

**Backend coverage — the crux.** `caps.compute` is `'native'` on WebGPU
(`rhi-webgpu/src/rhi-webgpu.ts:368`) and `'fragment-emulated'` on WebGL2
(`rhi-webgl2/src/rhi-webgl2.ts:598`). The WebGL2 lowering is STATELESS — one output texel per
feature via a fullscreen draw into R32UI (`rhi-webgl2/src/compute-webgl2.ts:1-9`). It cannot do
the read-previous / write-next ping-pong advection needs. The classic WebGL2 stateful particle
mechanisms (transform feedback; float render-to-texture ping-pong) are NOT exposed by the RHI,
and adding transform feedback would be a new backend-specific surface — exactly the
backend-identity fork #1046 forbids (`twin-frame-elimination.md:486-507`). So **(a) is
WebGPU-only** unless we either build a large new WebGL2 stateful-compute surface (rejected, §4.2)
or gate it behind `caps.compute === 'native'` with a fallback (recommended).

- **Perf envelope (Seoul):** trivial — 16k-particle advection is a few µs of GPU compute.
  Named seam: `dispatchKernel` (`compute.ts:283-334`) + the graphics draw. **At 10⁵–10⁶
  particles (5-year scale) this is the only candidate that stays sub-millisecond** — O(N) GPU
  work, zero per-frame CPU, zero per-frame upload.
- **Memory:** 2 × N × state-stride (ping-pong). At N=16k, stride ~8 floats ⇒ ~1 MB. At 10⁶ ⇒
  ~64 MB — real but bounded; a compute-scale concern, not a Seoul one.
- **#1046 interaction:** capability-gated, legitimate under the program IF the gate is a real
  `caps.compute` read (not `backend === 'webgpu'`) and the fallback is defined (§4.2). It also
  needs the NEW persistent-ping-pong compute pattern the dispatcher does not have today.
- **§5 verification (animated):** HARDEST. Ping-pong state is history-dependent — a probe frame's
  pixels depend on the entire sequence of dispatches since seeding. Deterministic capture
  requires seeding the state buffer to a KNOWN value AND running a FIXED step count at a FIXED
  dt before the probe. That harness is real work (§3.5).

**Verdict:** the scale winner, the backend loser. Right as a gated enhancement, wrong as the
baseline.

### 3.2 Candidate (b) — VS-integrated stateless particles (deterministic phase from a time uniform)

**Shape.** No state buffers at all. Each particle instance carries a static seed (home cell,
a per-particle phase offset, a random jitter). Its position at time `t` is a CLOSED-FORM
function evaluated in the VERTEX SHADER:

```
phase   = fract((t + seed.phaseOffset) / lifetime)        // 0→1 saw, loops
pos     = seed.origin + field(seed.cell).dir * (phase * driftLength)
alpha   = fadeIn(phase) * fadeOut(phase)                   // fade at birth/death
```

The particle is born at `seed.origin` (a jittered point in its gu), drifts a bounded
`driftLength` along that gu's constant outflow direction over its `lifetime`, fades out, and —
because `phase` is `fract` — is instantly reborn at its origin with the loop. Density ∝ volume
is achieved by ALLOCATING `n_i ∝ vol_i` particles to gu `i` at pack time (§2.3); the shader
never needs the volume, only the per-instance origin+direction. This reuses the arrow's exact
spine: the same `pointU` frame uniform + GPU projection ladder (`arrow-retained.ts:71-111`),
the same 6-vertex quad + analytic point/disc SDF (`circle-retained.ts:137-223` is the nearer
sibling — a plain disc), the same `executeItems` instanced draw (`arrow-retained-material.ts:68-84`).
The ONLY new shader input is the scalar `t` (§3.0).

**Why "stateless" is honest for THIS field.** The gu field is PIECEWISE-CONSTANT (one
`{fx,fy}` per gu, `seoul-arc-multiday.ts:207-212`). Within a cell, constant velocity ⇒ position
is EXACTLY linear in phase — the closed form is not an approximation, it is exact for the
in-cell drift. Cross-cell integration (a particle flowing from gu A into gu B) is NOT
represented; instead a particle's life is bounded to its home cell's drift and it respawns.
For the wind-map aesthetic (short lifetimes, high respawn, density as the volume signal) this
reads correctly and is what the effect needs — the Cut list (§4.5) states this fence explicitly.

- **Backend coverage:** BOTH, for free. The primitive is authored in `@xgis/shader-dsl` and
  emits a GLSL ES 3.00 twin behind the live `webgl2` guard exactly as arrow/circle do
  (`arrow-retained.ts:263-271`, `circle-retained.ts:241-249`, `arrow-retained-material.ts:24-27`).
  ZERO new RHI surface. This is the twin-kill-friendly option (#1046 satisfied by construction —
  no new backend branch exists to diverge).
- **Perf envelope (Seoul):** the arrow's already-verified envelope, unchanged — O(COPIES) draw
  calls, N-independent CPU per frame (`graphics-manager.ts:90-98,307-384`). The per-frame cost
  is the single `t` uniform write (§3.0). Named seam: the graphics-pass instanced draw
  (`arrow-retained-material.ts:75-83`). **At 10⁵–10⁶ particles the GPU vertex cost grows O(N)**
  (every particle is an instance every frame) — cheaper than a CPU repack but more vertex work
  than (a)'s compute; the honest ceiling where (a) pulls ahead (§4.1).
- **Memory:** N × seed-stride, packed ONCE (no ping-pong). At N=16k ⇒ ~0.5 MB.
- **#1046 interaction:** none adverse — it is a dual-source DSL pipeline, the sanctioned shape.
- **§5 verification (animated):** EASIEST. Position is a pure function of `(seed, t)`. Pin `t`
  to a fixed value via a probe override and the frame is FULLY deterministic — no seeding, no
  step count, no history. This is a decisive advantage (§3.5) and a direct consequence of
  statelessness.

**Verdict:** the right baseline — runs everywhere, verifies deterministically, kills no twin.

### 3.3 Candidate (c) — CPU advection → retained instance updates

**Shape.** Integrate every particle's position on the CPU each animation tick, then re-pack and
re-upload the instance buffer through the existing retained `update()` path
(`graphics-manager.ts:250-290`), riding the circle batch's attribute-granular re-upload.

- **Backend coverage:** BOTH (it uploads plain instance data; the draw is the dual-backend
  disc). No new shader math.
- **Perf envelope:** this is the retained-KILLER #797 forbids. The perf thesis is "accessors run
  ONCE at add()/update(), NEVER per frame" (`graphics-types.ts:6-9`); CPU advection re-runs the
  pack EVERY animation frame, which is O(N) CPU + an O(N) `writeBuffer` per tick
  (`graphics-manager.ts:277-288` — the feat re-upload is a WHOLE-buffer write, not a byte-range;
  "dirty-range" in #797 means attribute-granular, tint XOR feat, not sub-buffer). The #797 gate
  explicitly instruments that `_featWrites` (`graphics-manager.ts:90`) does NOT bump on
  per-frame camera motion — CPU advection bumps it every frame BY DESIGN, failing the spirit of
  that gate. At Seoul's 16k it is affordable; at 10⁵–10⁶ it is the O(N)/frame path the whole
  retained architecture exists to avoid.
- **Memory:** N × stride, plus the CPU-side particle array. Modest.
- **#1046 interaction:** none adverse, but it hard-caps scale at the CPU/upload bandwidth.
- **§5 verification (animated):** same history problem as (a) — CPU state is integrated frame to
  frame, so a probe needs a seeded start + fixed step count to be deterministic.

**Verdict:** simplest to write, but it violates the retained perf contract and caps scale. Fine
as a throwaway demo overlay; wrong for a 5-year engine primitive.

### 3.4 Comparison

| Axis                     | (a) compute advection        | (b) VS-stateless             | (c) CPU advection         |
| ------------------------ | ---------------------------- | ---------------------------- | ------------------------- |
| Backend coverage         | WebGPU only (`caps.compute`) | **BOTH (dual-source DSL)**   | BOTH                      |
| New RHI surface          | persistent ping-pong compute | **none**                     | none                      |
| #1046 posture            | gated enhancement only       | **sanctioned shape**         | ok, but scale-capped      |
| Per-frame CPU (Seoul)    | ~0                           | **~0 (one uniform write)**   | O(N) pack + O(N) upload   |
| Scale ceiling (5-yr)     | **10⁶ sub-ms**               | 10⁵–10⁶ (O(N) vertex)        | ~10⁴–10⁵ (upload-bound)   |
| Deterministic probe (§5) | seed + fixed-step harness    | **pin `t` — pure function**  | seed + fixed-step harness |
| Twin-kill-friendly       | no (WebGPU-only branch)      | **yes**                      | yes                       |
| Cross-cell integration   | possible (true advection)    | no (in-cell drift + respawn) | possible                  |

### 3.5 The §5 verification story for an ANIMATED effect

CLAUDE.md §5 forbids eyeballing; it requires a directional pixel-diff (`compare-diff.py`) + a
16-split read at full resolution. An animated effect breaks the premise that a frame is
reproducible. The design MUST expose a deterministic-capture seam:

- **A probe clock override.** A URL/global (`?animt=<seconds>` mirroring the `?rhichain`/
  `__xgisRhiChain` pattern, `map/src/debug-flags.ts:53-74`) that PINS the animation `t` to a
  fixed value instead of `performance.now()`. Under (b) this is SUFFICIENT and complete:
  position is `f(seed, t)`, so a pinned `t` yields a byte-reproducible frame — capture at
  `t = 0.25`, `t = 0.5`, `t = 0.75` to sweep the phase, diff each against a stored reference.
- **Under (a)/(c) the pin is necessary but NOT sufficient** — the state is history-dependent, so
  the harness must ALSO seed the state buffer to a fixed value and run a FIXED number of steps
  at a fixed dt before the probe. That is a strictly larger verification surface, and it is a
  first-order reason (b) is the baseline: the effect is verifiable with the tools the repo
  already mandates, without a bespoke state-seeding rig.
- **Gate conditions** (per the arrow's precedent, e363f4b0 real-GPU capture): at a pinned `t`,
  DC > 0 where particles appear (they render), D1 < D0 vs a reference (direction correct), and
  DC = 0 on the arrow/icon/circle fixtures (no regression to the siblings). Cross-backend is
  directional (DC/D1<D0), never pixel-exact (the standing §5 rule,
  `twin-frame-elimination.md:271`). Density ∝ volume is verified by a COUNT assertion (particles
  packed per gu ∝ `vol_i`), not by pixels — a numeric gate on the packer, the honest place to
  check a statistical property.

---

## 4. Recommendation, phase plan, and Cut list

### 4.1 Recommendation

**Ship candidate (b) — VS-integrated stateless particles — as the baseline `type:
'particle-flow'` primitive on both backends. Defer candidate (a) as a `caps.compute ===
'native'`-gated enhancement that FALLS BACK to (b) at Seoul scale, to be built only when a real
high-N (grid/national) field demands it. Reject candidate (c).**

Rationale, in priority order:

1. **Backend coverage without a twin.** (b) is a dual-source DSL pipeline
   (`arrow-retained.ts:263-271`), so it runs on WebGPU and WebGL2 from one authored module with
   zero new backend branch — the #1046-sanctioned shape (`twin-frame-elimination.md:113-118`).
   (a) cannot carry WebGL2 honestly (§3.1); (c) can, but at a scale cost (b) avoids.
2. **Verified-by-construction animation.** (b)'s statelessness makes the §5 deterministic-probe
   story a one-line clock pin (§3.5) — the effect is checkable with the repo's mandated tools,
   no state-seeding rig.
3. **Smallest delta on a proven spine.** (b) reuses the arrow/circle machinery wholesale — the
   only genuinely new code is the closed-form drift in the VS and the `t` seam (§3.0). #2/§3
   simplicity.
4. **Honest scale headroom.** Seoul (N≈4k–16k) does not need (a); building (a) now is
   speculative generality (§2 simplicity-first). When a 10⁶-particle field arrives, (a) slots in
   BEHIND `caps.compute` with (b) as the fallback path — no user-visible break, the #1046
   fallback discipline (`twin-frame-elimination.md:265-279`).

### 4.2 The WebGL2 arm decision (stated explicitly, as required)

**Decision: capability-gated presence of (a) with (b) as the universal baseline — NOT
transform-feedback emulation, NOT CPU integration as the baseline, NOT capability-gated
ABSENCE with only an arrows fallback.**

- The baseline particle-flow effect (b) runs on WebGL2 through the existing GLSL-twin path
  (`arrow-retained-material.ts:24-27`) — so WebGL2 users get PARTICLES, not merely a fallback to
  static arrows. This is strictly better than "capability-gated absence with the arrows
  fallback": the arrows fallback is reserved for the case where a device supports NEITHER path,
  which does not occur (any backend that draws the arrow draws the particle — same pipeline
  shape).
- (a) compute advection is gated `caps.compute === 'native'` (`rhi.ts:392-394`,
  `rhi-webgpu.ts:368`). On WebGL2 (`caps.compute === 'fragment-emulated'`,
  `rhi-webgl2.ts:598`) the gate selects (b). The gate is a REAL capability read, not
  `backend === 'webgl2'` — it satisfies #1046's caps-not-identity rule
  (`twin-frame-elimination.md:486-507`) and its value could change within a backend (a future
  ES3.1-class WebGL2-compute or WebGPU-everywhere world flips it with no consumer edit).
- **Rejected: transform-feedback / RTT-ping-pong WebGL2 stateful emulation.** It is a large new
  backend-specific surface the RHI does not model, i.e. the backend-identity fork #1046 exists to
  prevent (`twin-frame-elimination.md:14-16,486-507`), for a stateful-compute capability Seoul
  never needs. §2 simplicity + #1046 both forbid it.
- **Rejected: CPU integration as the baseline** — the retained-killer (§3.3, #797
  `graphics-types.ts:6-9`).

Net: particle-flow is present on BOTH backends via (b); (a) is an optional GPU-scale accelerator
gated on a real capability, absent-but-fallen-back-to-(b) where that capability is absent.

### 4.3 Phase plan (each phase gated + kill-switched)

Every phase: `bun run build` (typecheck authority, #11) + vitest + the named §5 probe, run
SEQUENTIALLY (§7). Every phase leaves the arrow/icon/circle paths byte-identical (branch on
`spec.type`, `graphics-manager.ts:189`). New DSL twins come from shader-dsl emit only (no hand
GLSL), matching the arrow (`arrow-retained.ts:263-271`).

**P0 — data contract + spec type + the animation-clock seam (additive, no visual change).**

- Scope: add `ParticleFlowDrawSpec` to the discriminated union (`graphics-types.ts:107`); add
  the `animU` frame-uniform field + its O(1)/frame write in the graphics pass
  (`graphics-manager.ts:340-363`); add the `?animt` probe-clock override (`debug-flags.ts`
  pattern, `:53-74`). Nothing renders yet.
- Gate: build + vitest (spec-type unit test; a map with no particle batch is byte-identical —
  the `hasGraphics` gate is unchanged, `graphics-pass.ts:29-31`); §5 DC=0 on the arrow fixture
  (proves the shared seam did not perturb siblings).
- Kill-switch: revert — additive.

**P1 — candidate (b) particle primitive on WebGPU (WGSL).**

- Scope: `particle-retained.ts` (DSL VS closed-form drift + disc-SDF FS, sibling of
  `circle-retained.ts`), `particle-retained-feat-layout.ts` (seed slots), `retained-particle-packer.ts`
  (per-gu `n_i ∝ vol_i` allocation, §2.3), `particle-retained-material.ts` (draper,
  `draw(6, N)`), the `spec.type === 'particle-flow'` branches in `graphics-manager.ts:189-244`.
- Gate: build + vitest (packer count test: particles per gu ∝ `vol_i`; draw-call
  N-independence, riding `graphics-manager.ts:90-98`); real-GPU at pinned `t`
  (`animt=0.25/0.5/0.75`): DC>0 where particles appear, DC=0 on the arrow/icon/circle fixtures.
- Kill-switch: no particle batch added ⇒ no pass (`hasGraphics`, `graphics-pass.ts:29-31`).

**P2 — GLSL twin ⇒ WebGL2 coverage (the arrow's #823 pattern).**

- Scope: `emitParticleRetainedGlsl(stage)` behind the live `webgl2` guard
  (`arrow-retained-material.ts:24-27`); no other change.
- Gate: build + vitest; the gl2 e2e gate renders particles; cross-backend DIRECTIONAL diff at
  pinned `t` (D1<D0 vs the WebGPU reference at identical cameras, `twin-frame-elimination.md:577`).
- Kill-switch: the GLSL emit is behind the backend guard; WebGPU boot never pays it.

**P3 — candidate (a) compute-advected state, `caps.compute === 'native'`-gated (OPTIONAL, deferred).**

- Scope: persistent ping-pong state buffers + a particle-advection kernel dispatched in the
  pre-pass block (`render-loop.ts:296-303`); the draw half reads the current state buffer. Gated
  `caps.compute === 'native'` (`rhi.ts:392-394`) with (b) as the fallback; a `?particlecompute=0`
  global forces (b) even on WebGPU (bisect tool, `debug-flags.ts:53-74` pattern).
- Gate: build + vitest; the deterministic harness (seed state + fixed step count, §3.5);
  compute-vs-(b) envelope at a high-N fixture; pass-order-parity unaffected (the kernel is a
  gated pre-pass consumer, no-particle map byte-identical, `render-loop.ts:299-302`).
- Kill-switch: the `caps.compute` gate + `?particlecompute=0`; absence of the cap ⇒ (b). Build
  P3 ONLY when a real high-N field lands (YAGNI); Seoul ships at P2.

### 4.4 LOC / ratchet impact

- **New files (P1/P2), sized off their siblings:** `particle-retained.ts` ~250 LOC
  (`circle-retained.ts` is 250); `particle-retained-feat-layout.ts` ~50 (`circle-retained-feat-layout.ts`
  is 49); `retained-particle-packer.ts` ~130 (`retained-arrow-packer.ts` is 110, +alloc logic);
  `particle-retained-material.ts` ~85 (`arrow-retained-material.ts` is 85). Each gets its OWN
  append-only LOC ceiling (the ratchet is shrink-only; new files add a baseline, they do not
  raise an existing one).
- **Edits:** `graphics-types.ts` +~20 (the new spec); `graphics-manager.ts` +~30 (materialise/
  render/update `type` branches, `:189-244,250-290,371-380`) — check its ceiling exists or add
  one; `graphics-pass.ts`/`graphics-manager.ts` +~10 for the `animU` write. `render-loop.ts`
  (ceiling 1205, `loc-ceiling-ratchet.test.ts:154`) grows only at P3 by the gated particle
  dispatch (~small). No existing ceiling is raised at P1/P2.
- **New per-frame cost:** exactly one — the `t` uniform write (§3.0), O(1) in N. The
  N-independence invariant (`graphics-manager.ts:90-98`) is preserved for (b): draw calls stay
  O(COPIES), CPU stays flat across N.

### 4.5 Cut list (recorded so it does not creep back)

- **No general particle system** — no user-defined force fields, no gravity/turbulence/curl-noise
  knobs, no 3D volumetric particles. The velocity is the per-gu outflow direction, full stop.
- **No per-particle collision or inter-particle interaction** — particles are independent;
  density is a pack-time allocation (§2.3), not an emergent property.
- **No cross-cell analytic integration in the (b) baseline** — a particle drifts within its home
  gu's constant field and respawns; it does not flow A→B. (True advection across cells is (a)'s
  territory, deferred.) This is the honest fence that keeps the closed form EXACT (§3.2).
- **No CPU-advection baseline** (candidate c) — the retained-killer (#797,
  `graphics-types.ts:6-9`).
- **No transform-feedback / RTT WebGL2 stateful-compute emulation** — new backend-identity
  surface #1046 forbids (§4.2).
- **No trails / streaklines in v1** — single-point particles. Trails need a float-blend
  accumulation target (`caps.floatBlendTargets`, `rhi.ts:385-391`) and are a later
  enhancement, not the first cut.
- **No new renderer / no new npm dep** — rides the graphics pass (`graphics-pass.ts`) and
  `executeItems` (`arrow-retained-material.ts:83`), exactly as #797 mandates.
- **No per-frame JS style closures** — accessors run ONCE at pack (`graphics-types.ts:6-9`); the
  only per-frame value is the shader `t` uniform.
- **No runtime mutation of compiled `.xgis` layers** — particle-flow is an additive host-drawing
  overlay, not a paint-property on a compiled layer (#797 non-goal).

---

## 5. Open questions for the maintainer (each with a recommended default)

1. **New `type: 'particle-flow'` vs a `mode` on a unified vector-field spec?**
   _Recommend:_ a NEW discriminated-union `type`, sibling of `'arrow'`/`'circle'`
   (`graphics-types.ts:107`). It matches the existing pattern and keeps each primitive's
   accessors honest (a particle spec's accessors differ from an arrow's). An app toggles by
   swapping which batch it `add()`s, as the demo already toggles representations
   (`seoul-arc-multiday.ts:380-387`).

2. **Where does the animation clock live — a field in `pointU`, or a sibling `animU`?**
   _Recommend:_ a small dedicated `animU` frame uniform. `pointU` is the shared ~160 B block
   icon/arrow/circle/point all read (`arrow-retained.ts:52`, `graphics-manager.ts:340-363`);
   adding an animation field there taxes every sibling's uniform for a value only particles use.
   A sibling block writes O(1)/frame only when a particle batch exists.

3. **Density ∝ RAW volume or the √-compressed `vnorm`?**
   _Recommend:_ RAW `vol` (`seoul-arc-multiday.ts:204`). Density is the honest encoding of
   volume; the √ compression (`vnorm`, `:210`) exists to keep the arrow's LENGTH legible, a
   different channel. Expose a gamma knob later if the raw dynamic range is too harsh, but start
   truthful.

4. **N cap default?**
   _Recommend:_ `N_cap = 4,096` typical with a hard ceiling of `16,384` (§2.3); per-gu
   allocation `n_i = clamp(N_cap · vol_i/Σvol, n_floor≈8, ·)` so the busiest gu dominates but
   the quietest still shows motion.

5. **Seed particles across the gu AREA (needs the polygon) or jitter around the centroid?**
   _Recommend:_ centroid + bounded random jitter for v1 (needs only `CENTROID`,
   `seoul-arc-multiday.ts:34` — no polygon point-in-poly at pack time). Area-accurate seeding
   (rejection-sample inside `seoul_gu.geojson`, `:151-157`) is a fidelity upgrade, gated behind
   its own flag, once the aesthetic is validated.

6. **Fixed max-N batch (like the fixed 25-instance arrow) or dynamic per-hour resize?**
   _Recommend:_ FIXED max-N batch; per-hour re-pack of the per-particle seed/cell assignment,
   mirroring the arrow's fixed-25 re-pack (`seoul-arc-multiday.ts:296-317`; a weak gu packs
   fewer live particles by setting their alpha/size to 0, never resizing — the retained batch is
   fixed-size, `graphics-manager.ts:257-263`).

7. **Ship candidate (a) compute for Seoul, or (b) only?**
   _Recommend:_ (b) ONLY for #826 (Seoul). Defer (a) behind the `caps.compute` gate until a
   genuine high-N field (grid/national) exists to justify the ping-pong state + the
   deterministic-seeding harness (§3.5). Building it now is speculative (§2).

8. **Trails/streaks in scope for #826?**
   _Recommend:_ NO — single points in v1 (§4.5). Trails need `caps.floatBlendTargets`
   (`rhi.ts:385-391`) accumulation and are a separate follow-up.

---

## 6. Risks and Socratic self-critique

**6.1 "The closed-form (b) drift is a lie — real flow crosses gu boundaries; you are showing
particles that stop at a wall."** The field IS piecewise-constant per gu by construction
(`seoul-arc-multiday.ts:207-212`) — there is no finer velocity to integrate against. A particle
that "crossed" into gu B would need B's field, i.e. true advection (candidate a). For the
wind-map READING — density as the volume signal, short-lived drifting dots implying current —
in-cell drift + respawn is faithful to what the 25-cell field actually says, and §4.5 fences it
as a stated non-goal rather than a hidden approximation. If cross-cell flow becomes a
requirement, that is precisely the trigger to build (a) (§4.3 P3), not to bolt cross-cell hacks
onto (b).

**6.2 "A per-frame time uniform means every particle map re-renders every frame forever — you
have broken the idle-frame contract."** Yes, and deliberately: an ANIMATED effect is inherently
a continuously-rendering effect, the same as any playing video. The bound that matters is that
the per-frame cost is O(1) in N (one uniform write, §3.0), not O(N) — so an animating particle
map costs one extra uniform write per frame over a static one, and the N-independence invariant
(`graphics-manager.ts:90-98`) still holds. A map with NO particle batch is byte-identical and
still idles (the `hasGraphics` gate, `graphics-pass.ts:29-31`). The knob to stop the animation
is not adding the batch, or setting its lifetime such that it settles — a policy, not an
architecture.

**6.3 "Deferring (a) is how features rot — you will ship (b), declare victory, and the compute
path never comes."** Acceptable and intended. (b) is not a stepping-stone to (a); it is the
correct answer for every field that fits in the vertex path (through ~10⁵–10⁶ particles, §3.2).
(a) is a DIFFERENT answer for a scale Seoul does not reach. If that scale never arrives, (a)
correctly never gets built (§2). If it does, (a) slots behind the `caps.compute` gate with (b)
as the live fallback — so the deferral costs nothing at the boundary (the fallback is the
shipped baseline, not a stub).

**6.4 "Candidate (b) still does O(N) vertex work per frame — you are one benchmark away from the
same O(N)/frame problem you accused (c) of."** Different axis. (c)'s O(N) is CPU pack + PCIe
upload EVERY tick — the bandwidth-bound path #797 forbids (`graphics-types.ts:6-9`). (b)'s O(N)
is GPU vertex shading of instances already resident in a packed-once buffer — the same class of
work the arrow does at its N, on the GPU, with zero per-frame CPU or upload. The named seam is
the arrow's own instanced draw (`arrow-retained-material.ts:75-83`); (b) inherits its measured
N-independence on the CPU side exactly. The point where GPU vertex cost itself becomes the
bound is the 10⁶ ceiling where (a) is the answer — stated, not hidden (§3.2, §4.1).

**6.5 "The animation clock is a new frame-shell input — does it collide with the #1046 pass-order
authority or the twin?"** The `t` write lives INSIDE the graphics pass's per-frame uniform write
(`graphics-manager.ts:340-363`), not in the pass ORDER — it adds no pass, changes no order, so
`pass-order-parity.test.ts` and `PASS_CHAIN_ORDER` (`pass-order.ts:19-29`) are untouched. Only
P3's compute kernel touches the pre-pass dispatch block (`render-loop.ts:296-303`), and it does
so as a gated, no-particle-map-byte-identical consumer (`render-loop.ts:299-302`) — the same
discipline every §2.5 fallback in the twin-frame program follows.

---

## Appendix A — verified file:line evidence

Every claim above traces to a line read during this design. Grouped by subsystem
(verified 2026-07-14 against `origin/main` at `56dfad34`):

- **Static arrow primitive (the spine to reuse):** `map/src/shaders/dsl/arrow-retained.ts`
  (header `:1-16`, feat/tint storage `:58-59`, `project_geo` ladder `:71-111`, two-point VS
  `:132-165`, quad+SDF `:167-244`, module build `:246-252`, WGSL emit `:256`, GLSL twin
  `:263-271`); `map/src/shaders/dsl/arrow-retained-feat-layout.ts` (25-slot layout `:28-60`,
  tint stride `:63`); `map/src/graphics/retained-arrow-packer.ts` (feat pack `:87-110`, TIP step
  `:25-27`, DSFUN pack `:60-82`); `map/src/render/material/arrow-retained-material.ts` (draper
  `:17-52`, GLSL-behind-guard `:24-27`, `draw(6,count)` `:68-84`).
- **Circle sibling (nearer to a plain disc particle):** `map/src/shaders/dsl/circle-retained.ts`
  (disc SDF FS `:195-223`, quad VS `:112-192`, GLSL twin `:241-249`);
  `map/src/shaders/dsl/circle-retained-feat-layout.ts` (18-slot layout `:23-46`).
- **Retained batch machinery + perf contract:** `map/src/graphics/graphics-types.ts`
  (accessor purity `:6-9`, `IconUpdateTrigger` `:41`, `ArrowDrawSpec` `:63-82`, `CircleDrawSpec`
  `:89-104`, `DrawSpec` union `:107`, `DrawHandle` `:110-118`);
  `map/src/graphics/graphics-manager.ts` (write counters `:90-98`, `add` `:153-171`,
  `hasRetainedBatches` `:180-182`, `materialise` type-branch `:189-244`, `updateBatch`
  whole-buffer re-upload `:250-290`, `renderRetained` N-independence `:307-384`, per-copy uniform
  write `:340-363`).
- **Graphics pass (chain entry):** `map/src/render/passes/graphics-pass.ts` (pass `:26-53`,
  `shouldRun` gate `:29-31`, single-sample onto resolved swapchain `:36-52`);
  `map/src/render/passes/pass-order.ts` (`PASS_CHAIN_ORDER`, graphics last `:19-29`,
  `RHI_TWIN_MISSING` `:38-43`); `map/src/render/passes/pass-chain.ts` (`PASSES` record `:54-64`,
  `buildRenderNodes` `:72-74`); `map/src/render/scene-view.ts` (`hasGraphics` `:46-49`, wiring
  `:80`); `map/src/map.ts` (graphics manager `:320-322`, `registerNodes` `:1069`, repaint hook
  `:1072`).
- **Compute capability + dispatcher (candidate a):** `rhi/src/rhi.ts` (`RhiCaps` `:369-403`,
  `compute` field + consumer note `:392-394`, `caps` on device `:415`, `floatBlendTargets`
  `:385-391`); `rhi-webgpu/src/rhi-webgpu.ts` (caps values, `compute:'native'` `:363-371`);
  `rhi-webgl2/src/rhi-webgl2.ts` (caps values, `compute:'fragment-emulated'` `:592-601`);
  `rhi-webgl2/src/compute-webgl2.ts` (stateless per-feature lowering `:1-9`);
  `rhi-webgpu/src/compute.ts` (stateless dispatch `:107-142`, P4 3-binding kernel `:157-171`,
  `dispatchKernel` `:283-334`); `map/src/render-loop.ts` (compute pre-pass dispatch `:296-303`,
  no production consumer today `:299-302`); `map/src/render/renderer.ts`
  (`dispatchComputePass` `:314-320`).
- **#1046 constraints + frame-shell seams:** `docs/plans/2026-07-14-twin-frame-elimination.md`
  (RHI absorbs / dual-source `:113-129`, per-cap fallback semantics `:265-279`, cross-backend
  directional gate `:271,577`, caps-not-identity `:486-507`); `map/src/render-loop.ts`
  (twin gate `:260-276`, frame-shell `acquire*` `:282-289`); `rhi/src/rhi.ts`
  (`acquireScreenView`/`acquireFrameEncoder` `:475-489`).
- **Dev-flag / kill-switch pattern:** `map/src/debug-flags.ts` (`?rhichain` + global mirror
  `:53-80`, page-load-flag convention `:1-19`).
- **LOC ceilings:** `map/src/loc-ceiling-ratchet.test.ts` (`vector-tile-renderer.ts` 4487 `:93`,
  `render-loop.ts` 1205 `:154`).
- **Seoul field data contract:** `playground/src/seoul-arc-multiday.ts` (98,837 flows / 54.7%
  intra `:5`, conformal bearing invariance `:17-19`, 25-gu index + centroid `:34-35`, `Vec` shape
  `:131-133`, `computeField` outflow + `vnorm` `:190-213`, raw `vol` `:204`, arrow batch
  `:296-317`, size ∝ vnorm `:311-314`, per-hour re-pack `:334-336`, autoplay tick `:389-404`,
  representation toggles `:380-387`); `examples/03-graphics-icons-arrows.ts` (public arrow API
  `:44-56`).
