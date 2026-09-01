# 08 — Content subsystems: text, style compiler, coverage, particles, globe surface

> Edition: **agent**. Companion: [`../dev/08-content-subsystems.md`](../dev/08-content-subsystems.md).
> This chapter is a survey; each section names its authority files.

## 1. Text: SDF glyphs, manual shaping, deterministic collision

- **Dual glyph source**: MapLibre-format glyph PBF ranges (protobuf parsed in-house) with
  a Canvas2D + **exact Felzenszwalb-Huttenlocher distance transform** fallback (tiny-sdf
  packing: 0 = far inside, 192 = edge). The key move: the local raster size is pinned to
  **24 px to match PBF native**, so PBF→atlas is a 1:1 byte copy with a no-op rescale —
  resampling was measurably softening labels vs MapLibre. The provider chain is
  chain-of-responsibility: cheap sync probes first, then background `ensure()`s while the
  fallback renders so a frame never blanks; landing invalidates the slot and the next
  prepare silently upgrades. `ensure` must fire its callback on **terminal** states
  including 404/CORS — otherwise the placeholder draws forever. In-flight ranges join the
  pending-work registry (before that, "idle" meant "converged except for text").
- **Atlas**: pure-logic LRU slot state over a single 4096²/64px-slot R8 page by asserted
  contract (see [`06-memory-upload.md`](./06-memory-upload.md) §8). Weight/style are
  **interned into the fontKey** with sentinel separators (plus a display-size bucket
  suffix for locally-rasterized ideographs) — bold and regular hash to different slots for
  free, and the atlas never learns that weights exist.
- **Shaping is manual** (no HarfBuzz): advance accumulation over cached metrics with
  MapLibre's constants re-derived; line breaking is Knuth-Plass behind an FNV-keyed LRU
  (the uncached wrap dominated prepare at 44 ms/frame during zoom oscillation; the
  string-concat cache key was itself the top GC source).
- **CJK**: an engine-injected fallback font chain (stripped again before deriving the PBF
  fontstack name — a glyph server doesn't know CSS-only families); local ideograph
  rasterization at display-size buckets (a minified 24 px SDF turns small CJK into solid
  boxes); **vertical writing composed directly** (offsets advance +y at em pitch, rotation 0) rather than reproducing MapLibre's rotate-then-counter-rotate pair — X-GIS composes
  offsets on the CPU each frame, so the cancelling pair is removed, not mirrored. Two
  recorded traps: column pitch is the **em, never the glyph advance** (PBF has no vertical
  advance); and the cross-axis centerline is one value from the em box, never per-glyph
  `bearingY` (an ink metric — bilingual columns zig-zag).
- **Line labels**: cadence and phase are different bugs. Spacing must scale as
  `spacing · dpr · 2^frac(zoom)` (the tile-unit bake, verified 0.998-1.001 against
  MapLibre over a zoom sweep); the walk's **phase must anchor in a world frame the data
  already carries** (the first vertex of the tile-sliced Mercator polyline) — a
  screen-space walk starts wherever the road enters the viewport, so phase was
  camera-dependent by ~4 px. Collision for path labels is a chain of circles refining the
  box, plus a cheap same-line spacing gate checked before bbox collision.
- **Collision** is greedy first-claim-wins over a **deterministic 5-level order**:
  `symbol-sort-key` → layer-precedence group → **`nearY` descending** → stable per-feature
  identity → input index. Two postmortems built that order: the tie-break was once tile
  _dispatch order_ (the winner was whoever loaded last — fixed with a stable identity +
  permutation test), and then at pitch 81° the stable identity was deciding a _depth_
  question ("Seoul" < "Shanghai" let the far label occlude the near one) — **"stable is
  not the same as correct"**; `nearY` is the screen-space depth proxy slotted between
  precedence and identity. The same depth-blind bug was latent in the icon pass.
- **Halo** is one-pass (fill composited over halo via `1 − fill_w`), with the halo edge
  **floored at the AA band** — a per-fontScale-packed width descended below the SDF
  background at small sizes and drew an opaque box behind small labels.
- **Fades** are a ledger: prepare (rare) sets targets; a per-frame advance mutates alpha
  in place so a fade never forces a re-prepare. Fade identity **strips the
  layer-precedence prefix** that shifts at integer-zoom stops (stable symbols otherwise
  read as gone+new — the blink) while collision keeps the full id. A fade-out holdover
  bakes screen pixels, so under a similarity-safe camera regime it is re-solved
  (scale+translate from replay refs) instead of suppressed — labels dropped during zoom
  now fade instead of popping.

## 2. Labels in 3D

- Ground-projected labels take a per-label 2×2 basis = **a ratio of the projection's own
  forward Jacobians**: finite-difference the live projector and the pitch-0 projector at
  the label's location and solve `basis = ΔP · ΔP₀⁻¹`. Properties stated as load-bearing:
  no inverse projection anywhere (azimuthal discs have none), **identity at pitch 0 by
  construction** (a property of the code, not a tolerance), the probe step cancels, and
  it's evaluated where the label is (the predecessor linearized at the screen center and
  was 84-240 % wrong at the viewport edge). The identity case omits the field so
  pitch-0 vertices stay bit-identical. Collision boxes go through the same basis. Globe is
  explicitly deferred with the reason recorded — _don't_ patch it with a per-projection
  analytic fallback (that's the two-authorities drift the construction avoids).
- Curved labels under pitch walk **two polylines sharing sample indices** — the pitch-0
  label plane (arc length, fit, max-angle, advance = uniform-on-the-ground quantities) and
  the live screen (positions). Glyph rotation uses the **label-plane** tangent (the
  renderer composes basis·R(θ), and basis·t_plane ∝ t_live — feeding the live tangent is
  ~18° off at pitch 60); upright flipping uses the live tangent. Since the renderer applies
  `pivot + B·(offset − pivot)`, offsets store the **pre-image** `B⁻¹·(live − pivot)` so
  positions reproduce exactly while quads still transform through B.
- Globe anchors must project through the **RTC (focus-relative) MVP as `e − focus`** —
  absolute ECEF into an RTC matrix splays labels off features (sharp probe: the
  view-center anchor's ECEF _is_ the RTC origin, so a correct projector centers it at any
  pitch). Horizon culling uses the shared ellipsoid-silhouette authority plus two margins:
  a **fractional** margin of the visibility headroom `(1 − cosH)` (an additive angular
  margin fails because headroom collapses with zoom: 0.0027 at z12, 4e-5 at z18), and a
  7 px screen-space limb inset — final form only after a three-round postmortem whose
  lesson is that the margin must live **where the quad height exists** (a per-label
  extent, not the anchor point).

## 3. The style compiler

Front end: lexer → recursive-descent parser → AST. The language is **purely declarative**
(if/for were removed); utilities are `modifier:name-[expr|pipe]` items recorded verbatim
by the parser and resolved later.

- **Utility vocabulary is a declarative registry** — one `{prefix, valueKind, unit,
animatable, appliesTo}` row per utility with **longest-match lookup** so table order is
  irrelevant. It replaced ~78 prefixes dispatched through ordered `startsWith` ladders
  duplicated across four sites (with two silent-drop holes). Consumers derive from the
  table (keyframe animatability is a filter over it); an unmatched utility is a diagnostic
  with nearest-name help. One coarse row (`label-*`) delegates to its own sub-authority
  rather than enumerating twice.
- **IR**: `lower()` builds a Scene of render nodes; binding lowering is a handler registry
  honoring matched-but-not-consumed fall-through; `optimize()` is a pass manager
  (topo-sorted dependencies, fixpoint DCE group). One unified value model
  (`PropertyShape<T>`) for every paint property.
- **Expression classification** is the heart:
  `constant | zoom-dependent | input-dependent | per-feature-gpu | per-feature-cpu` with a
  join lattice for composite nodes. Two subtleties worth copying: a field access must
  classify **through its object** (an expression is only as GPU-safe as its parts —
  returning gpu unconditionally routed CPU-only bodies to a path where unknown callees
  emit 0.0, a silent wrong value); and the GPU-safe builtin set is a documented **subset**
  of all builtins, with a containment test (every GPU-routed name must also be
  CPU-evaluable for fallback and folding).
- **Routing** (`paint-routing.ts`): inline-constant | palette-zoom (a zoom-interpolated
  gradient atlas row) | compute-feature | cpu-uniform. Per-feature match/gradient
  expressions can lower to **per-feature compute kernels** (workgroup 64, output
  `pack4x8unorm` into a u32 buffer, a const-array LUT past 16 arms), deduped by CSE
  annotation then by emitted-WGSL fingerprint; the polygon variant then reads
  `unpack4x8unorm(compute_out[fid])`.
- **Safety invariant to copy**: the integer category ids baked into shader match-chains
  must equal what the runtime feature packer writes — both sides sort patterns
  alphabetically; breaking it silently mis-colors with no type error. Similarly, `input`
  declarations are rewritten into a distinct `InputRef` node _before_ any other pass —
  a distinct Expr kind forces every exhaustive switch to handle it (the prior
  bare-identifier fallback silently compiled unknown names to 0.0).
- **Mapbox compatibility** is a converter plus a **spec-coverage table** assembled from 17
  per-section descriptor files (parallel work never conflicts), with two drift gates:
  every property the converter references appears in the table, and every table row is
  actually referenced. Definition of done (ADR-0012): every row `supported`, or `partial`
  with a warning-backed degradation note — **silent drops are defects**; 15 `na` rows are
  reaffirmed architecture decisions, not backlog. The ADR carries no status column (a
  second status authority would drift).
- Honest gap, recorded loudly rather than papered over: `hover:*` state is parsed but
  **not wired to the GPU** — unhandled modifiers are a diagnostic (previously
  `hover:opacity-100` compiled clean into a no-op), and interaction state is CPU-side
  (pick MRT readback, rAF-coalesced, gated on listener presence so hoverless maps never
  pay the readback). For a new library: design the per-feature **state lane** (hover/
  select bits in the feature table, a `DEPS_STATE` axis) up front — it is the one thing
  X-GIS's classification lattice reserved no room for.

## 4. Coverage: scientific gridded data (S-102/S-111)

- **ADR-0010**: read the standard **in place** (HDF5 over HTTP Range); the house container
  was deleted. "A reader for a standard is legitimate; transcoding a standard into a house
  blob is not" — paid for twice (`.xgvt` → PMTiles, `.xgcov` → HDF5). CORS is a proxy
  concern, not a format concern.
- The in-house HDF5 reader's range layer holds the **measured crossover**: on a real
  4.5 MB NOAA cell, whole-file GET = 125 ms; ranged = 2,100 ms _and it transferred nearly
  everything anyway_ (an unwindowed read touches every chunk, and each address is known
  only after its predecessor parses ⇒ K ≥ ~6 serial round-trips). Algebra:
  ranged = `K·RTT + needed/T` vs whole = `RTT + total/T` ⇒ whole wins while
  `(K−1)·RTT > (total − needed)/T`; hence a whole-file threshold at 8 MB, with ranging
  reserved for what it's actually good at (one forecast group out of dozens in a
  multi-timestep cell). File size is learned from a 1-byte range GET's `Content-Range`
  (HEAD isn't always allowed, and the probe simultaneously proves range support).
- **Region discovery is STAC** — not a house catalog. The reasoning: an S-100 cell id is
  not computable from a bbox, so the real question is where the bbox→id table lives;
  inventing `catalog.json` would be "`.xgcov` one level up." Overlap ranking prefers the
  smaller (higher-resolution) cell on area ties.
- **ADR-0011**: three consumers (readout, drape order, arrow suppression) answered "which
  domain owns this water" independently, and **recency was standing in for relevance** (it
  looks like relevance until a forecast re-arm lands — the winner flipped several times a
  second). One authority function, passed to all three; drape uses a **stable** descending
  sort; the eviction LRU is deliberately untouched (it wants the opposite order). Gate:
  one test reads all three through their real code paths at one probe point.
- Rendering: value + validity as **two r16float textures** (rg16float isn't renderable on
  WebGL2), a 256×1 ramp LUT, and a tessellated grid over the cell's outer edges projected
  through the general projection ladder — CPU-reprojected through **the cell's own CRS**
  (a projected UTM footprint is not a lon/lat rectangle). Two invariants in the source
  header: async reads claim an epoch token **per region** (one shared counter made each
  new region cancel all others — a mosaic collapsed to whichever loaded last), and never
  rebuild the scene to refresh one coverage (that froze the map on every forecast step).
- **Soundings** (depth numerals): the candidate lattice is walked in **screen space, not
  grid space** — bounded by the viewport (~hundreds), not the grid (3.5 M cells);
  scale-thinning falls out free; values come from nearest-cell reads (never interpolated —
  a printed number must exist in the data); decluttering delegates to the label collision
  system.

## 5. Particles / flow (three generations, each with the design argument)

1. **Stateless particles**: position = pure function `f(seed, t)` — no state buffer, no
   compute, GLSL twin free, and a pinned `t` gives byte-reproducible frames (the
   determinism seam). Compute advection is a capability-gated _enhancement_, never the
   baseline, because the WebGL2 arm can't honestly carry it.
2. **The drifting-glyph postmortem**: porting the particle lifecycle to large oriented
   chart glyphs is _structurally_ wrong — recycling is a position discontinuity, hiding it
   needs a fade, and a fade on a large recognizable object IS a blink. The particle model
   works only under perceptual conditions (sub-tracking-threshold dots, high density,
   trails). **"A lifecycle model is only as portable as the perceptual conditions that
   make its artifacts invisible."** The industry answer is two layers: static glyphs
   (exact, not animated) + a flow field (motion, never a discrete object). The flow field
   is IBFV texture ping-pong **sized to the coverage grid, not the canvas** (history is
   camera-independent; no screen→geo inverse anywhere in the recursion); the step sequence
   (ensure → clear-only-when-fresh → advect old→new, never same texture → swap after
   draw) is behind a draw seam so it's testable without a GPU; velocity is stored as
   **components, not speed+direction** (interpolating degrees across 0/360 averages 350°
   and 10° to 180°); advection steps are anisotropic (`cos φ` — dividing both axes by the
   same number shears the flow).
3. **Arrows ARE the particles** (S-111): the standard's portrayal catalog binds a
   _function_ (position → speed/direction → symbol/color/rotation) and contains **no
   notion of time** — so a drifting arrow re-evaluated from the data wherever it arrives
   is conformant; one that keeps its old color after moving is not. Design: store a
   **displacement, not an absolute position** (origins keep the CPU-packed split-float
   precision; the displacement is bounded so f32 suffices and no projection math is
   recomputed — both escapes measured/argued closed: CPU re-pack ~27 ms/frame; in-shader
   reprojection is the CPU/GPU-twin bug archetype). Then the state texture was removed
   entirely: **a phase holds no position** — `drift(origin, phase)` is pure, so instance
   count becomes a per-frame decision (no texture to size, no identity to preserve), fades
   become possible, determinism is free, and frame 0 _is_ the catalog placement. The
   instance set is a **ground-anchored lattice generated from the view** (screen-seeded
   fields slide over the water; ground-seeded density is constant per screen area by
   construction — measured: holding spacing at z19 from a data-seeded set would need 355 M
   instances). Trains of glyphs at fixed arc spacing make recycling free: at phase 1 every
   glyph lands where its neighbor was and the alpha ramp matches across the seam — _there
   is nothing to blink_. The camera reaches the lattice as **four corner rays unprojected
   through the f64 inverse** — not an inverse matrix (f32 inverse ≈ 1 m ≈ 8+ px at z17)
   and not a second basis derivation (a second statement of a composition the forward path
   owns = a lattice that slides).

## 6. Globe surface

- **Background is a synthetic earth-surface tile** (ADR-0005): a 128×64 lat/lon mesh
  through the standard opaque polygon pipeline as `shows[0]`, replacing a standalone
  background renderer that had been a second projection path, second geoid, second
  world-copy story. `background-pattern` therefore works world-anchored on flat and globe
  alike.
- **Defined coverage** (ADR-0007): a bucket-0 background pass owns the whole-viewport
  clear with a pure function `(projType, style bg, overdraw) → clear color`; flat
  projections clear to the style background (the in-band earth redraws it, so no band
  boundary), discs/globe clear to deliberate space-black. This **deliberately reverses** a
  MapLibre-parity convention because "every viewport pixel has a defined source" outranks
  parity at letterbox/horizon pixels — record the reversal so it doesn't look like a bug.
  The atmosphere limb-glow is a separate pass right after background, gated on the same
  boolean the camera branches on (`globeMode`) so the two can never disagree about which
  matrix is live.
- **Raster on the globe**: no skirts — a per-tile subdivision grid (floor 8×8) whose edge
  vertices are shared by construction. The precision fix (#2137) is a chapter of its own:
  every transcendental on the in-shader ECEF path multiplies the Earth radius, so a
  backend's relative trig error lands as **meters** (measured 1.17e3 m on SwiftShader);
  feeding a more precise latitude _measurably did not help_ (the forward sin/cos/sqrt
  dominate) — the fix removes every transcendental (a CPU-f64 trig table; the shader only
  multiplies). Units trap recorded: one lane holds the dimensionless log-tangent, not
  Mercator meters — using the meter-inverse silently shifts every vertex. Edge blending is
  **temporal, not spatial**: zoom-in fade over the cached parent; zoom-out cross-fade
  retaining departing children under the parent; the fade clock is wall-clock, not frame
  count (a frame-count fade ran 2× slow at 30 fps and 2× fast at 120).
- **Interop (ADR-0008) is documentation, not code** — the three contracts an external
  renderer cannot assume: the camera is a fused RTC-relative MVP (no separable
  view/projection); depth is logarithmic with per-fragment `frag_depth` (an external mesh
  writing linear Z z-fights); geometry is split-float ECEF-RTC on a
  sphere-camera/ellipsoid-vertex geoid so "this is ECEF" is ambiguous. Each has a named
  ~50-LOC bridge, deliberately unbuilt. For a new library with interop ambitions: keep
  view and projection unfused in the public API from day one, publish the depth encoding
  as frame state, and brand the geoid frames.

## 7. Transferable design rules

1. **Match your glyph raster size to your glyph source's native size** — resampling SDFs
   is a quality tax; intern all cache-key axes (weight, style, size bucket) into one key.
2. **Deterministic collision order with an explicit depth proxy** — stable identity is for
   reproducibility; screen-Y (or true depth) is for correctness; keep both, in the right
   order, and lock with a permutation test.
3. **Anchor along-path label phase in world space; scale spacing by `2^frac(zoom)`.**
4. **Derive 3D label bases from the projection's own Jacobians** (ratio of live to pitch-0)
   — no inverses, identity at pitch 0 by construction, correct everywhere on screen.
5. **Classify style expressions into an execution lattice** (constant / zoom / input /
   feature-gpu / feature-cpu) with classification-through-subexpressions and a
   GPU-safe ⊆ CPU-evaluable containment gate; reserve a state axis (hover/select) in the
   lattice from day one.
6. **Utility/property vocabularies are declarative registries with longest-match lookup**;
   unknown names are diagnostics with suggestions, never silent no-ops.
7. **Read standards in place over HTTP ranges — but measure the range/whole crossover**
   (serial address discovery makes small files cheaper whole); discover data through the
   ecosystem's catalog standard, not a house manifest.
8. **When N consumers must agree on a ranking, pass one authority function** — and watch
   for recency masquerading as relevance.
9. **Animate fields, not objects**: a recognizable glyph must be exact and static (or
   re-evaluated from data where it arrives); motion belongs to dense sub-threshold
   carriers or pure phase functions. Prefer stateless `f(seed, t)` — determinism, free
   fades, per-frame instance counts.
10. **Every-pixel-defined beats reference-parity**; when you reverse a convention, write
    the reversal down.

## 8. Code map

- Text: `map/src/text/` (`text-stage.ts`, `text-renderer.ts`, `text-collision.ts`,
  `text-wrap.ts`, `vertical-writing.ts`, `label-fade.ts`, `holdover-reproject.ts`,
  `ground-basis.ts`, `curved-glyph-walk.ts`, `sdf/`)
- Compiler: `compiler/src/{lexer,parser,ir,codegen,convert}/`
  (`utility-registry.ts`, `classify.ts`, `paint-routing.ts`, `shader-gen.ts`,
  `compute-gen.ts`, `spec-coverage/`)
- Coverage: `data/src/hdf5/`, `map/src/coverage-*.ts`, `map/src/render/coverage-renderer.ts`,
  `docs/adr/0010`, `docs/adr/0011`, `docs/standards/s-111/`
- Flow/arrows: `map/src/shaders/dsl/{particle-retained,flow-advect,arrow-advected,
arrow-drift,field-lattice}.ts`, `map/src/render/flow-*.ts`,
  `docs/plans/2026-07-14-particle-flow-design.md` and successors
- Globe surface: `map/src/synthetic-earth-surface-show.ts`,
  `map/src/render/passes/{background-pass,atmosphere-pass}.ts`,
  `map/src/render/raster-*.ts`, `docs/adr/{0005,0006,0007,0008}`
