# S-100 GAP-2 — Part 9/9a Portrayal Engine (S-101 ENC + GML overlays → rendered chart)

**Status:** design proposal (2026-07-16), architect pass. All X-GIS claims are file:line-grounded against `main` @ `63e2c436`; all S-100 claims are tied to the feasibility report (`docs/research/2026-07-16-s100-rendering-feasibility.md` — hereafter **[FR]**) or explicitly marked _to-verify_.
**Scope:** GAP-2 of [FR] §6.2 — the rule-based portrayal/symbology engine: how S-101 ENC vector features (LIGHTS, BCN\*, BOY\*, DEPARE, …) and GML overlay features (S-124 warnings, S-412 weather) become a rendered chart through the IHO S-101 Portrayal Catalogue (217 `.lua` + 725 `.svg`, [FR] §4.2).
**Gate:** ⛔ **Implementation is explicitly gated on GAP-3** (ellipsoid datum unification, epic #1152, `docs/architecture/design/ellipsoid-datum-unification.md` — hereafter **[ED]**; INC-1 camera-anchor unification in CI now). This document is DESIGN-ONLY parallelization; no portrayal increment that renders positions may start before [ED] INC-1 (camera anchor) and INC-2 (ellipsoid unproject) are merged — a portrayal engine that draws at the wrong datum is not worth building first ([FR] §6.2 GAP-2 sequencing). The one exception is INC-0 (offline catalogue inventory), which touches no engine code.
**Companion docs:** `docs/architecture/design/s100-gap1-hdf5-coverage.md` (**[G1]** — the coverage/LUT seam this design composes with), [ED], [FR].

---

## 0. Summary — decisions up front

1. **Lua = OFFLINE portrayal compilation (option c), hardened into a hybrid (option d) by a runtime parameter lattice.** The S-101 PC's Lua 5.1 rules run **only** in the offline converter (`s101-compile`), over the ingested cell's features, using a real Lua engine as a **devDep** (devDeps are policy-allowed; runtime deps are not — verified: no `@xgis/*` package has a `dependencies` block in its `package.json`). The runtime **never executes Lua**. The mariner-context problem this creates is solved by classifying each of the 14 context parameters into three lattice classes: **α** (continuous depth params → per-feature data-driven expressions against a new runtime `param` uniform — the single compiler extension this design needs), **β** (boolean params → dual-baked layer variants + the existing per-frame `visible` flip, `map/src/layer.ts:233-240`), **γ** (Day/Dusk/Night → palette-texture + sprite-atlas swap, the seam [G1] §5.1 reserved). No parameter requires re-running Lua at runtime; no parameter requires re-tiling.
2. **Symbols = offline rasterization of the 725 SVG-Tiny-1.2 symbols into three per-palette sprite atlases** in the exact Mapbox sprite JSON+PNG protocol that `SpriteAtlasHost` already consumes unchanged (`map/src/sprite/sprite-atlas-host.ts:5-8`). Pivot points are handled in v1 by **pad-to-centre** at rasterization time (zero engine change); a sprite-JSON `pivot` extension is the v2 upgrade. The in-repo GPU SDF vector-shape system (`map/src/text/sdf-shape.ts:1-14`) is deliberately **not** used for the 725 point symbols (painter's-order fidelity risk, §4.2) but **is** the designated home for S-52 complex **linestyles** — it already exists for exactly that job (the `symbol { path "M…" }` construct + 3-slot line pattern stack, `compiler/src/ir/emit-commands.ts:141`; the playground even ships an "S-100-inspired line decoration library", `playground/public/data/libs/s100-lines.xgis`).
3. **Colour = S-52 token-index authority.** Every colour the converter emits is a **token index** into a 3-palette (Day/Dusk/Night) colour table baked from the PC's `colorProfile.xml` ([FR] §4.3) and uploaded as a palette texture — riding the existing categorical-palette bindings (`map/src/render/feature-data-binder.ts:49-53`). Palette switch = one texture swap + one sprite-atlas swap; nothing re-tiles, nothing re-compiles.
4. **Display control maps almost entirely onto existing machinery:** display priorities + planes + the area→line→point→text tie-break ([FR] §4.2) → converter-sorted layer declaration order (buckets draw in declaration order, `map/src/render/bucket-scheduler.ts:1-13`; text draws last via the label pass); viewing groups / display modes → per-layer `visible` flips (`setPaintProperty(id,'visibility',…)`, `map/src/map.ts:3880-3886`); SCAMIN / IgnoreScaleMinimum → layer `minzoom` (per-frame gated, `bucket-scheduler.ts:251-256`) plus one small new zoom-range-override API.
5. **Ingest is a prerequisite, scoped as its own increments, converter-first (the [G1] pattern):** an in-house zero-dep ISO/IEC 8211 reader (offline now) inside `s101-compile`, which ingests → runs PC Lua → emits **native vector tiles (`.xgvt`/PMTiles) + a generated `.xgis` style + 3 sprite atlases + the palette table + a pick-report sidecar**. GML (S-124/S-412) gets a sibling converter sharing the feature model and emit stages.
6. **Honesty:** this targets an **S-101-styled chart display for a web GIS library**, NOT a type-approved ECDIS (§8.1). Alerts, Part-15 decryption, live update application, radar, and IEC 61174 conformance are explicit non-goals.

---

## 1. Requirements (from the verified PC structure)

Everything a Part 9/9a renderer must honour, per [FR] §4 (confidence flags inline):

| #   | Requirement | Source |
| --- | --- | --- |
| R1  | Pipeline: Feature Data → Portrayal Engine (XSLT 1.0 **or** Lua 5.1 via Part 13) → Drawing Instructions → Rendering Engine → output. S-101's PC is **Lua-based** (~98%: 217 `.lua`), entry `PortrayalMain`, host callback `HostPortrayalEmit`, **optional portrayal cache** | [FR] §4.1, §4.2, §3.1 |
| R2  | Drawing-instruction types: Null / Point (parameterizable symbol) / Line / Area / Text / Coverage; Part 9a instructions are a **command-driven state machine** consistent with SVG and S-52 DAI | [FR] §4.2, §4.1 |
| R3  | PC folder contract: `portrayal_catalogue.xml` + Pixmaps / ColorProfiles / **Symbols (SVG + CSS2)** / LineStyles (XML) / AreaFills (XML) / Fonts (TrueType) / Rules (Lua) | [FR] §4.2 |
| R4  | Symbols: **SVG Tiny 1.2 subset** (S-100 SVG profile, Appendix 9-B), y-down, `viewBox` + explicit **pivot point**, colour via CSS classes `.sXXXXX`/`.fXXXXX` (stroke/fill per token) with literal fallback | [FR] §4.2 |
| R5  | Colour: S-52-inherited token model; `colorProfile.xml` = 3 palettes **Day/Dusk/Night**, token→(CIE xyL + sRGB); switching = token→RGB remap | [FR] §4.3 |
| R6  | Display control: **Viewing Groups** (instruction off if ANY of its groups is off) → Viewing Group Layers → **Display Modes** (DisplayBase / StandardDisplay / OtherInformation); **Display Planes** (OverRadar/UnderRadar); **Display Priorities** with tie-break **area→line→point→text** | [FR] §4.2 |
| R7  | **Transparency composes multiplicatively**: (1−t₁)(1−t₂) | [FR] §4.2 |
| R8  | **Portrayal CRS = output-device pixels**; symbol rotations may be defined **relative to the North axis** of the geographic CRS | [FR] §4.2 |
| R9  | **14 mariner context parameters** (SafetyDepth 30, SafetyContour 30, FourShades false, ShallowContour 2 — enabled only when FourShades, ≤ SafetyContour; DeepContour ≥ SafetyContour; ShallowWaterDangers, PlainBoundaries, SimplifiedSymbols, FullLightLines, RadarOverlay, IgnoreScaleMinimum, PreferredLanguage, SafetyHeight) — "a renderer must expose these and re-run portrayal when they change". ⚠️ [FR] §4.3 says "all 14 verified" but **enumerates 13 names** — the canonical list must be pinned from the PC `<context>` block at INC-0 (_to-verify_) | [FR] §4.3 |
| R10 | Input: S-101 topology-3a vector features (P/C/S, 2-D except 3-D point soundings, CW outer boundaries, masking via `[MASK]`), ISO-8211-encoded, WGS84 lon/lat ints at COMF 10⁷ | [FR] §3.1, §5.1 |
| R11 | GML overlays: S-124 / S-412 / S-421 are Part-10b GML vector products (their own PCs; whether those PCs are Lua or XSLT is _to-verify_) | [FR] §2.3 |
| R12 | Exact **per-rule usage of each context parameter inside the 217 `.lua` files** is NOT in [FR] — the α/β/γ classification in §3.3 is engineering inference to be **verified mechanically at INC-0** by scanning the PC sources | _to-verify_ (INC-0) |

---

## 2. Current-state inventory — fits and gaps (file:line)

### 2.1 What already fits

| PC concept | X-GIS machinery | Evidence |
| --- | --- | --- |
| Point drawing instruction (symbol at position, screen-px size, rotation, collision) | Icon pipeline: per-icon `rotateRad`, SDF tint, collision AABB + padding, paired-symbol drops | `map/src/sprite/icon-stage.ts:56-91` |
| North-referenced symbol rotation (R8) | `resolveIconRotateRad` — `icon-rotate` + rotation-alignment=map tangent + keep-upright fold | `map/src/render/passes/label-pass.ts:80-107`; text twin `map/src/render-loop-helpers.ts:164-176` |
| Data-driven per-feature symbol selection | icon-image accepts `get`/`match`/`coalesce` expressions, resolved per feature → IconStage | `compiler/src/convert/layer-converters/symbol.ts:39-58` |
| Sprite atlas hosting rasterized symbols | Mapbox sprite JSON+PNG protocol, @2x DPR variant, SDF-tint flag; host-image atlas (#797) | `sprite-atlas-host.ts:5-8, 35-37, 50-52`; `host-atlas-packer.ts:1-18`; `host-image-registry.ts:22-62` |
| Line instruction: solid/dash + **repeated-symbol decorations** | SDF line renderer: dash array + **pattern stack of 3 symbol slots** laid along the line | `map/src/render/line-pattern.ts:22, 41-42`; `compiler/src/ir/emit-commands.ts:141` |
| Vector path symbols (for linestyles) | `symbol { path "M…" }` → `ShapeRegistry` → GPU storage-buffer SDF (M/L/C/Q/Z), shared by point + line renderers; per-segment `colorIdx` | `compiler/src/schema/language.ts:107-117`; `map/src/text/sdf-shape.ts:1-14, 26-40, 44-49, 303` |
| Area instruction: fill + pattern fill | fill/line/background-pattern `supported` in the spec-coverage authority | `compiler/src/convert/spec-coverage/layout-fill-line.ts:25-31, 54-57` |
| Text instruction | SDF glyph pipeline (Canvas2D rasterizer) + greedy bbox collision + label pass draws after content | `map/src/text/sdf/glyph-rasterizer.ts:150-223` |
| Priority ordering (R6) | buckets draw in **declaration order** (converter sorts layers); minzoom/maxzoom gate per-frame | `map/src/render/bucket-scheduler.ts:1-17, 251-256` |
| Viewing-group on/off (R6) | per-frame `visible` flip, no rebuild | `map/src/layer.ts:233-240`; `map/src/map.ts:3880-3886` |
| Token→RGB palettes (R5, γ) | categorical palette machinery: palette colour atlas + sampler bound per tile, stable category ids; 256×1 LUT bake | `map/src/render/feature-data-binder.ts:49-68`; `map/src/color-ramp.ts:120-158` |
| Per-feature conditional paint (α) | data-driven feature buffer + per-layer GPU **compute paint** per frame; `case`/`step`/comparison expression handlers; runtime colour constructors (f01fd1ad) | `feature-data-binder.ts:1-27`; `map/src/render/compute-layer-handle.ts:1-36`; `compiler/src/convert/expr-registry.ts:83-92` |
| Layer-count containment | `merge-layers` IR pass exists | `compiler/src/ir/passes/merge-layers.ts` |
| Converter-first offline precedent | `.odb` CLI→artifact→zero-dep decode; [G1]'s `s100-to-xgcov` | [G1] §3; `pipeline/src/odb/format.ts:1-28` |

### 2.2 What is genuinely missing

1. **Any rule engine mapping feature+attribute+context → drawing instructions** — [FR] §6.2 GAP-2, confirmed: no Lua, no XSLT, no interpreter in the tree (none permitted at runtime by zero-dep policy).
2. **Any ISO-8211 or GML reader** — confirmed absent (the only "s100" artifact is the hand-authored `s100-lines.xgis` symbol demo).
3. **A runtime-settable scalar parameter usable inside expressions.** Today the only runtime-varying expression input is zoom; `setPaintProperty` handles constants only and documents that expression changes require a full re-compile (`map/src/map.ts:3833-3839`). The α lattice class needs a `param` construct (§3.4).
4. **Arbitrary per-sprite pivot points.** `IconAnchor` is a 9-way enum (`map/src/graphics/graphics-types.ts:26-35`), not an (x,y) pivot.
5. **Palette-indexed colour as a first-class paint lowering** (token index → palette texture lookup for constant-coloured layers, not just categorical data-driven fills).
6. **A feature-attribute query / pick-report surface.** Feature events are a Phase-4 stub (`map/src/layer.ts:135-139`); no `queryRenderedFeatures`. S-101 pick reports (OBJNAM full detail, [FR] §3.1) need an attribute sidecar + point query.
7. **Multi-page sprite atlas or atlas-set switching.** The host atlas is a single fixed 1024×1024 page that skips images that don't fit (`host-atlas-packer.ts:17-18, 52-57`); 725 symbols × 3 palettes need per-palette atlas URLs (chosen, §4.2) or paging.

---

## 3. THE Lua decision

### 3.1 Options weighed

|     | (a) In-house Lua 5.1 interpreter subset | (b) WASM Lua | (c) Offline portrayal compilation | (d) = (c) + runtime parameter lattice |
| --- | --- | --- | --- | --- |
| Zero-runtime-deps | ✅ but ~8–15k LOC language runtime owned for 5 years | ❌ **hard policy violation** | ✅ runtime never sees Lua | ✅ same |
| Part 9a fidelity | Partial by construction (subset); every gap a silent mis-render | High | High **offline** (real Lua engine as devDep) | High offline; runtime replays the _effect_ of param changes (§3.3) |
| Param change (SafetyContour 10→20) | Re-run rules in browser: O(features) Lua-in-JS per change | same | ❌ naive (c): re-convert shore-side — unacceptable for an interactive control | ✅ uniform update + visibility flips, <1 frame, no re-tile |
| Untrusted-code surface | Interpreter executing catalogue-supplied code in the page — sandboxing burden forever | worse (opaque WASM) | Zero: rules execute in the publisher's build step | same |
| 5-year maintenance | The largest liability in this table | Third-party WASM build chain | Converter isolates ALL catalogue churn offline; PC updates = re-run converter | same + one small generic compiler feature (`param`) |
| Spec posture | "True" runtime portrayal | same | The spec blesses a **portrayal cache** ([FR] §4.1/R1) — offline compilation is a persisted portrayal cache. Honest deviation: a conformant ECDIS "re-runs portrayal" on param change; we replay its effect (§8.1) | same |

### 3.2 Verdict

**(d): offline Lua compilation + runtime parameter lattice.** (b) disqualified by policy. (a) dominated for a 5-year library: it buys drag-and-drop-a-cell at the price of owning a language runtime, an interpreter security boundary, and per-change O(features) CPU — for a capability the shore-side converter provides with a _real_ Lua engine and loud offline failures. (c) alone fails interactivity on SafetyContour. The lattice makes (c) interactive without Lua.

Two design locks make (d) durable:

- **The converter's output schema IS the Part 9a drawing-instruction model** (§6.1): a typed, versioned instruction stream (Point/Line/Area/Text/Null + viewing group + priority + plane + transparency). If a runtime rule engine is ever demanded (INC-Ω), it emits the _same_ instruction stream into the _same_ style-emitter.
- **Offline Lua engine choice pinned at INC-0** (_to-verify_): the PC targets Lua 5.1 (Part 13); candidates (fengari ≈5.3, wasmoon ≈5.4, vendored PUC lua5.1 via child_process) have semantics deltas. INC-0 runs the PC's own rules under each candidate against sample cells and picks zero-divergence — or vendors the reference binary.

### 3.3 The parameter lattice — all context parameters

Classes: **α** = per-feature data-driven expression against a runtime `param` uniform; **β** = converter dual-bakes affected layers, runtime flips `visible`; **γ** = palette/atlas swap; **δ** = small dedicated mechanism. Every "effect" cell is S-52-lineage inference — **INC-0 mechanically verifies each row against the actual 217 `.lua`** (R12).

| Parameter (default) | Portrayal effect (inferred) | Class | X-GIS mechanism |
| --- | --- | --- | --- |
| **SafetyContour** (30) | Re-classifies every DEPARE/DRGARE fill, selects+emphasizes the safety contour, activates isolated-danger symbols — the classic S-52 conditional-symbology core | **α** | Converter bakes per-feature depth attrs (DRVAL1/DRVAL2, VALSOU) into the feature buffer; fills lower to `case(lt(feat.drval1, param(safetyContour)), token(SHALLOW…), token(DEEP…))` via existing `case`/comparison handlers evaluated by compute paint per frame. **Snap-to-available-contour** (_to-verify_) computed CPU-side: converter bakes the sorted contour-depth set into style metadata; `map.setParameter` snaps before writing the uniform |
| **SafetyDepth** (30) | Sounding text colour (black ≤ vs grey >) | **α** (caveat) | Same comparison on the sounding Z; needs a per-feature text-colour channel in the label path — _to-verify_ at INC-5; fallback: two pre-baked sounding layers with a `param`-driven opacity gate |
| **FourShades** + **ShallowContour** + **DeepContour** | 2-band vs 4-band depth shading | **α** | Folds into the same DEPARE classification expression; two extra uniforms, inert when fourShades=0 |
| **ShallowWaterDangers** | Extra danger symbolization in shallow water | **β** | Dual-baked layer pair + `visible` flip |
| **PlainBoundaries** | Plain vs symbolized boundary linestyles | **β** | Two line layers (plain dash vs pattern-stack decoration) + flip |
| **SimplifiedSymbols** | Simplified vs paper-chart symbol set | **β** | Two icon layers (both atlas-resident) + flip |
| **FullLightLines** | Full vs short light-sector legs | **β** | Sector legs/arcs are Lua-augmented geometry — baked twice, flipped |
| **RadarOverlay** | Portrayal variants under radar | **β** | Flip of affected layers (inventory at INC-0) |
| **IgnoreScaleMinimum** | SCAMIN bypass | **δ** | SCAMIN bakes to layer `minzoom`; add `map.setLayerZoomRange(id,min,max)` override — generic API, ~S |
| **PreferredLanguage** | National vs international text | **β** | Dual-baked text layers + flip |
| **SafetyHeight** | Vertical-clearance highlighting | **α** | Comparison against baked VERCLR attrs; tiny feature set |
| _(plus)_ **Day/Dusk/Night** | Token→RGB remap of everything | **γ** | Palette-texture swap + per-palette sprite-atlas swap. [G1] §5.1 reserved the LUT seam |

**Why the lattice cannot explode:** α params are uniforms — zero artifact growth. β params are pairwise-independent booleans, each duplicating only its _own_ affected layer set — total growth is a **sum** of small subsets, never the 2⁷ product; geometry tiles are shared. γ is three colour tables + three atlases. This is the load-bearing argument for (d) over (a): the state space "re-run portrayal" walks at runtime factorizes completely into uniforms, visibility bits, and one palette index.

### 3.4 The one compiler extension: `param`

A declared, typed, runtime-settable scalar usable in expressions:

```xgis
param safetyContour { default: 30 }
layer depare { source: enc | fill-[case(lt(get("drval1"), param(safetyContour)), token(DEPVS), token(DEPDW))] }
```

Lowering: `param(x)` → one f32 slot in the existing layer/compute uniform path; `map.setParameter(name, value)` writes the slot + invalidates (flicker-free, same discipline as `setPaintProperty` but WITHOUT the "expressions require re-compile" limitation at `map.ts:3837-3839` — the expression compiles once, only the uniform changes). This is a **generic** 5-year feature (theme thresholds, user-driven styling), not S-100 plumbing — it belongs in `@xgis/compiler` proper.

---

## 4. Symbol pipeline decision (725 SVG Tiny 1.2 + pivots + CSS tokens)

### 4.1 Options

|     | (A) Offline rasterize per palette → sprite atlas | (B) Runtime SVG-Tiny subset renderer | (C) Offline SVG → in-repo SDF shape |
| --- | --- | --- | --- |
| Fidelity vs 725 arbitrary symbols | ✅ by construction — offline rasterizer (resvg/Chromium devDep) differentially gated | Medium — own subset walker (~1–2k LOC) must survive all 725 | ❌ risky: a single-SDF shape is a **union**, not painter's order; multi-element symbols mis-render; strokes need offline stroke-to-path; arcs unsupported (`sdf-shape.ts:44-49` M/L/C/Q/Z only) |
| Day/Dusk/Night | Atlas swap (3 pre-built) | Re-rasterize on switch | ✅ free (per-segment colorIdx → palette) |
| Zoom/DPR | Symbols are **screen-fixed size** (R8) → no zoom scaling; DPR via existing `@2x` protocol | Native-DPR always | Infinite |
| Engine change | ~zero (atlas protocol as-is); pivot pad-to-centre v1 | New runtime module | Point-symbol paint-order machinery — real renderer work |

### 4.2 Verdict

**(A) offline per-palette rasterization for the 725 point symbols; (C) for line decorations; (B) rejected for v1** (kept as the INC-Ω companion of a runtime rule engine).

- `s101-compile` rasterizes each SVG at 1×/2× with palette token colours substituted into `.sXXXXX`/`.fXXXXX`, emits `enc-sprite-{day,dusk,night}.{json,png}` in the Mapbox protocol — `SpriteAtlasHost` loads unmodified.
- **Pivot v1 — pad-to-centre:** rasterizer pads each frame so the SVG pivot lands at frame centre; `anchor:'center'` is then exact. **Pivot v2:** optional `pivotX/pivotY` in sprite JSON + icon quad math.
- **Palette switch:** three atlases packed with **identical layouts** by construction (same packer input order — the shelf packer is the single layout authority) → switch = rebind the sampled atlas view; packed UV rects stay valid.
- **Line styles:** simple → dash arrays; complex → `symbol { path }` + the 3-slot pattern stack. ⚠️ >3 distinct symbol slots per linestyle would overflow — census at INC-0; mitigation = split into two stacked layers.
- **Area fills:** pattern fills ride the supported fill-pattern path, sourcing from the same atlas.

---

## 5. Display-control mapping

| PC mechanism | Mapping | New machinery? |
| --- | --- | --- |
| **Display Priorities** + area→line→point→text tie-break | Converter emits layers sorted by `(displayPlane, priority, geomClass)`; buckets draw in declaration order; text/icons render in the label pass after content — the text-last tie-break holds structurally | None (a converter sort) |
| **Display Planes** (Under/OverRadar) | Two contiguous bands in the layer order; host radar overlay slots between | None |
| **Viewing Groups** (off if ANY group off) | One layer ⊂ one viewing-group set; a JS-side `ViewingGroupController` maintains group→layers and applies the ANY-off rule via `visible` flips | S: host-side controller — no engine change |
| **Display Modes** (Base/Standard/Other) | Three preset viewing-group configurations through the same controller | None |
| **SCAMIN** / IgnoreScaleMinimum | Baked `minzoom` + `setLayerZoomRange` override (§3.3-δ) | S |
| **Multiplicative transparency** (R7) | Converter multiplies instruction transparency into emitted token alpha / layer opacity at bake time | None |
| **Layer-count risk** | S-101 ≈ low-hundreds of layers after `merge-layers`. Measured risk (§8.6); escape hatch = per-feature viewing-group bitmask + mask uniform — deferred until profiling proves need | — |

---

## 6. Ingest prerequisite scoping (ISO-8211 + GML, converter-first)

### 6.1 `s101-compile` (the CLI)

```
S-101 .000 (+.001… updates) ──┐
S-101 Portrayal Catalogue ────┤  s101-compile (offline, bun; devDeps allowed)
mariner defaults ─────────────┘
        │ 1. iso8211 reader (in-house, pure DataView, ~1–2k LOC — same purity rule as [G1] §3.3)
        │ 2. GFM feature assembly (features, info types, associations, complex attrs → flat columns + sidecar)
        │ 3. PC Lua execution (real Lua 5.1 engine, devDep; PortrayalMain/HostPortrayalEmit contract, R1)
        │ 4. Drawing-instruction stream (typed, versioned — the Part 9a-shaped seam, §3.2)
        │ 5. Lattice factoring: α attrs → feature columns; β → layer variants; γ → token indices
        ▼
.xgvt / PMTiles tiles  +  generated .xgis style (+ params)  +  3 sprite atlases  +  palette table  +  pick-report sidecar
```

- Emitting **native VT tiles + a generated `.xgis` style** (both existing runtime concepts) means the runtime learns **no S-101 concept at all** — the content-blind discipline [G1] applied to coverages.
- ISO-8211 oracles: GDAL's S-57 driver validates the 8211 container layer; S-101-profile deltas pinned against IHO/NOAA sample cells (_to-verify_ at INC-1 kickoff: sample-cell availability + whether GDAL ships an S-101 vector driver as a second oracle).
- Updates (`.001`…) applied **offline** by the converter; live browser update application is a non-goal.
- **Masking** (`[MASK]`, R10) honoured at instruction emission — masked curve segments emit no Line instruction.

### 6.2 GML (S-124 / S-412): `s100gml-compile`

Sibling CLI sharing stages 2–5: offline XML → same feature model → the products' own PCs (Lua? XSLT? _to-verify_ — if XSLT, the offline engine is an XSLT 1.0 devDep processor, same architecture) → same emit. Overlay datasets are small; v1 may emit inline GeoJSON sources. S-412 time-varying weather composes with [G1]'s time machinery where coverage-like — boundary pinned at INC-6.

---

## 7. Increments (each small, testable; heavy jobs sequential per CLAUDE §7)

**INC-0 — PC inventory probe (offline only; NOT gated on GAP-3).**
Machine-scan the real S-101 PC: (i) per-rule context-parameter reads → the verified α/β/γ table (kills R12 inference); (ii) resolve the 13-vs-14 count (R9); (iii) SVG census (elements/attrs, arcs, pivots, sizes vs the 1024 page); (iv) LineStyles census vs the 3-slot stack; (v) Lua-engine semantics probe (§3.2).
Gate: committed inventory JSON + a design-addendum diff where inference was wrong.

**INC-1 — ONE lighthouse.** ⛔ starts only after [ED] INC-1+INC-2 merged.
Minimal 8211 path (LIGHTS features from one real NOAA/IHO cell), hand-driven Lua run for the LIGHTS flare rule, rasterize that flare's SVG ×3 palettes, emit a 2-layer style, render at correct position + **north-referenced rotation** from ORIENT, Day/Night switch. Excludes sector arcs/legs (INC-7).
Gates: (i) position oracle — CPU lon/lat→screen computed independently, icon centre within 1 px; (ii) rotation gate — synthetic 0/90/180/270 ORIENT fixtures, packed quad angles asserted CPU-side + headed render; (iii) palette gate — texel readback: Day RGB ≠ Night RGB, both equal `colorProfile.xml`; (iv) §5-ladder pixel-diff (16-split; measured noise floor).

**INC-2 — Point-symbol corpus + display control.**
Full 725-symbol atlas build, BOY*/BCN* rules through the real Lua stage, ViewingGroupController + Display Modes.
Gates: atlas differential gate (each sprite == reference rasterizer, per palette); Base/Standard/Other flips exactly the inventoried layer sets (unit); headed spot-render 16-split.

**INC-3 — Depth bands: the conditional-symbology increment.**
`param` construct (§3.4) + DEPARE/DEPCNT classification + SafetyContour/FourShades/Shallow/Deep + snap-to-contour; token-index paint lowering through the palette texture.
Gates: fail-first CPU gate — `safetyContour` change re-buckets a synthetic DEPARE fixture per the S-52 truth table; GPU gate — param flip re-colours with **zero re-tile** (frame-hash: only depth-area pixels change); build + both LOC ratchets.

**INC-4 — Lines + areas.** Dash + pattern-stack linestyles, PlainBoundaries flip, AreaFills pattern fills. Gates: linestyle census coverage; pattern-stack overflow fails loudly at convert time.

**INC-5 — Text + soundings.** Sounding text via label pipeline, SafetyDepth α-colour (or documented two-layer fallback), PreferredLanguage dual-bake, pick-report sidecar + minimal `map.queryFeatureAt(lon,lat)` over CPU-resident columns. Gates: sounding colour truth table; collision determinism fixture.

**INC-6 — GML overlays (S-124 first).** `s100gml-compile`, warnings rendered above the OverRadar band. Gates: schema-fixture round-trip; overlay renders above all ENC content by construction.

**INC-7 — Full display-control + light sectors.** Complete priority/plane ordering, sector arcs/legs (augmented geometry + FullLightLines β-flip), RadarOverlay flips, `setLayerZoomRange`.
Gate: a real harbour cell side-by-side against an independent S-101 viewer — **advisory** visual comparison + the §5 ladder against our own goldens (_to-verify_: whether S-164-style test material publishes expected renders usable as a stronger oracle).

**INC-Ω (demand-gated, out of committed scope):** runtime rule engine reading the same instruction schema + runtime SVG renderer for drag-and-drop cell+catalogue; viewing-group bitmask fast path; Alert Catalogue.

---

## 8. Risks

1. **Conformance honesty (headline).** A conformant ECDIS additionally requires IEC 61174 type approval, S-164 test execution, alerts, Part-15 decryption, live updates, CIE-calibrated colour, radar. **We are NOT building a type-approved ECDIS** — the honest claim is "renders S-101 cells using the official Portrayal Catalogue, compiled shore-side". This sentence belongs in the S-100 module README.
2. **The α/β/γ table is inference until INC-0.** If a parameter gates rule structure beyond α/β expression, the fallback is honest: that parameter becomes a converter re-run knob in v1 and the addendum says so.
3. **Offline Lua semantics drift** (5.1 vs 5.3/5.4) — silent divergence. Mitigated by the INC-0 engine probe + differential fixtures; worst case vendors PUC 5.1.
4. **PC/SVG redistribution licence** for baked atlases — _to-verify_ before shipping demo artifacts publicly.
5. **Atlas capacity**: 725/palette vs the single 1024² page — INC-0 sizes it; per-palette URL atlases sidestep the host-page packer limit.
6. **Layer-count frame cost** — measured risk with a named escape hatch (bitmask), not a blocker.
7. **GAP-3 coupling**: chart-correctness claims are meaningless pre-[ED]; the vertical-datum channel stays reserved — soundings display values verbatim without pretending to transform datums.
8. **Label pipeline gaps**: per-feature text colour (INC-5) and pick reports (Phase-4 stub, `map/src/layer.ts:135-139`) — the two places existing machinery needs genuine extension; both scoped, small-to-medium.
9. **Local VT-tile dev-environment constraint** (project memory: local VT tiles unreliable in playground; inline GeoJSON works) — INC-1 verification must pin the harness first.

## 9. Trade-offs (consolidated)

| #   | Decision | Chosen | Rejected | What we give up |
| --- | --- | --- | --- | --- |
| T1  | Rule engine | Offline Lua (devDep) + parameter lattice (d) | (a) in-house interpreter; (b) WASM | No drag-and-drop cell+PC in the browser (v1); param semantics replayed, not re-derived — INC-0 must prove the replay complete |
| T2  | Param interactivity | Generic `param` uniform construct | Re-convert per change | One compiler feature to own; buys flicker-free SafetyContour + a generic styling capability |
| T3  | Point symbols | Offline per-palette raster atlases | Runtime SVG subset; SDF meshes | 3× atlas bytes; pivot padding waste until v2 |
| T4  | Line decorations | In-repo SDF shape + pattern stack | Rasterized dash textures | 3-slot ceiling (split-layer mitigation) |
| T5  | Colour | Token-index + palette texture everywhere | Baking RGB per palette | Slightly more complex lowering; buys single-swap Day/Dusk/Night + composes with [G1] LUT |
| T6  | Viewing groups | Layer-per-VG + `visible` flip + JS controller | Per-feature bitmask uniform (now) | Layer count low-hundreds; bitmask kept as escape hatch |
| T7  | Ingest | Converter-first, in-house 8211, native tiles out | Runtime 8211; GeoJSON-only | No in-browser cell loading; converter owns updates |
| T8  | Conformance | Honest "styled chart display" | Chasing ECDIS conformance | Marketing claim strength — deliberately |

## 10. References

**X-GIS (verified against `main` @ `63e2c436`):** `compiler/src/schema/language.ts:59-67, 107-117` · `compiler/src/parser/parser-statements.ts:173` · `compiler/src/ir/emit-commands.ts:141` · `compiler/src/convert/expr-registry.ts:83-92` · `compiler/src/convert/layer-converters/symbol.ts:39-58` · `compiler/src/ir/passes/merge-layers.ts` · `compiler/src/convert/spec-coverage/layout-fill-line.ts:25-31, 54-57` · `map/src/text/sdf-shape.ts:1-14, 26-49, 303` · `map/src/map.ts:1385-1400, 2676-2704, 3833-3890` · `map/src/layer.ts:135-139, 233-240` · `map/src/render/bucket-scheduler.ts:1-17, 251-256` · `map/src/render/feature-data-binder.ts:1-27, 49-68` · `map/src/render/compute-layer-handle.ts:1-36` · `map/src/render/line-pattern.ts:22, 41-42` · `map/src/render/passes/label-pass.ts:80-107` · `map/src/sprite/sprite-atlas-host.ts:5-8, 35-52` · `map/src/sprite/host-atlas-packer.ts:1-18, 52-57` · `map/src/sprite/icon-stage.ts:18-91` · `map/src/graphics/graphics-types.ts:26-35` · `map/src/text/sdf/glyph-rasterizer.ts:150-223` · `map/src/color-ramp.ts:120-158` · `playground/public/data/libs/s100-lines.xgis` · package.json sweep (zero runtime `dependencies`).

**S-100 grounding:** [FR] §§2.2-2.3, 3.1-3.2, 4.1-4.3, 5.1-5.2, 6.1-6.2, 7 · [G1] §§3-5, 8 · [ED] §Target, §"S-100 scope honesty".

**Open to-verify (tracked into INC-0/INC-1):** canonical 14-parameter list from the PC `<context>` block; per-rule context-param usage across the 217 `.lua`; snap-to-available-contour semantics; Lua-engine 5.1-semantics choice; SVG census; LineStyles slot census; S-124/S-412 PC mechanism (Lua vs XSLT); sample-cell availability + GDAL S-101 driver; S-164-style expected-render oracles; PC/SVG redistribution licence; per-feature text-colour support in the label path.
