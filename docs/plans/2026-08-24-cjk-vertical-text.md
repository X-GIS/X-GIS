# CJK vertical text — `text-writing-mode` via a per-glyph rotation pipeline

- **Track**: ADR-0012 Phase **D7**
- **Date**: 2026-08-24
- **Status**: design (no code in this PR)
- **spec-coverage row today**: `text-writing-mode` — `unsupported` / `medium`,
  note _"CJK vertical text would need a per-glyph rotation pipeline."_
  (`compiler/src/convert/spec-coverage/layout-symbol.ts:133-138`)
- **Reference implementation read for this doc**: `maplibre-gl@5.24.0` and
  `@maplibre/maplibre-gl-style-spec@24.8.5`, both vendored under `node_modules/.bun/`.
  Every MapLibre claim below carries a `file:line` from that tree — none is from memory.

---

## 1. What the property actually is

### 1.1 It is a POINT-placement property

`v8.json` `layout_symbol.text-writing-mode` declares:

```json
"requires": [ "text-field", { "symbol-placement": ["point"] } ]
```

and documents the array as _"the order of elements in an array define priority
order for the placement of an orientation variant"_, with the values acting as a
**hint** — _"a symbol whose language doesn't support the provided orientation will
be laid out in its natural orientation"_.

> **Scope correction.** This track was briefed as _"vertical only for line
> placement of CJK-dominant labels"_. That is the inverse of the spec.
> `text-writing-mode` is gated to `symbol-placement: point`. Line-placed labels do
> get verticalized in MapLibre, but by a **different, independent mechanism**
> (§1.3) that is not this property and is not D7. The prior in-repo research note
> reached the same conclusion for the same reason
> (`docs/research/2026-06-19-mapbox-compat-roadmap.md:80`), so this is a
> re-confirmation, not a new finding.

### 1.2 The three cooperating mechanisms (point path)

MapLibre implements vertical point labels as three separate steps. All three are
needed; none of them is "stack the glyphs downward".

**(a) Which glyphs verticalize** — `symbol/shaping.ts:276-287`:

```ts
function isLineVertical(writingMode, allowVerticalPlacement, codePoint): boolean {
  return !(
    writingMode === WritingMode.horizontal ||
    (!allowVerticalPlacement && !codePointHasUprightVerticalOrientation(codePoint)) ||
    (allowVerticalPlacement &&
      (charIsWhitespace(codePoint) || charInComplexShapingScript(codePoint)))
  )
}
```

As a truth table, for `writingMode === vertical`:

| `allowVerticalPlacement`             | codepoint                           | `vertical` | who takes this branch |
| ------------------------------------ | ----------------------------------- | ---------- | --------------------- |
| `true` (point / `text-writing-mode`) | CJK, Latin, digits, punctuation     | **true**   | §1.2 point path       |
| `true`                               | whitespace                          | false      | —                     |
| `true`                               | Arabic/Devanagari (complex shaping) | false      | —                     |
| `false` (line / keep-upright)        | UAX#50 upright (CJK)                | **true**   | §1.3 line path        |
| `false`                              | Latin, punctuation                  | false      | —                     |

**(b) Layout still advances along +x** — `symbol/shaping.ts:379-387`. Even in
vertical mode the pen runs horizontally; the only change is that a verticalized
glyph advances by a fixed `ONE_EM` instead of its own `metrics.advance`:

```ts
if (!vertical) {
  x += metrics.advance * section.scale + spacing
} else {
  shaping.verticalizable = true
  const verticalAdvance = 'imageName' in section ? metrics.advance : ONE_EM
  x += verticalAdvance * section.scale + spacing
}
```

**(c) Two rotations that cancel.** The whole label is rotated **+90° (CW)** at
draw time — `data/bucket/symbol_bucket.ts:652` and `webgl/draw/draw_symbol.ts:251`,
identically:

```ts
const angle = allowVerticalPlacement && writingMode === WritingMode.vertical ? Math.PI / 2 : 0
```

and every glyph marked `vertical` is pre-rotated **−90° (CCW)** at quad-build time
so that it survives that label rotation upright — `symbol/quads.ts:304-327`:

```ts
const center = new Point(-halfAdvance, halfAdvance - SHAPING_DEFAULT_OFFSET)
const verticalRotation = -Math.PI / 2
const xHalfWidthOffsetCorrection = ONE_EM / 2 - halfAdvance
const halfWidthOffsetCorrection = new Point(
  5 - SHAPING_DEFAULT_OFFSET - xHalfWidthOffsetCorrection,
  -yImageOffsetCorrection,
)
tl._rotateAround(verticalRotation, center)
  ._add(halfWidthOffsetCorrection)
  ._add(verticalOffsetCorrection)
```

MapLibre's own comment on that block (`quads.ts:286-288`) states the intent
plainly: _"Vertical POI labels that are rotated 90deg CW and whose glyphs must
preserve upright orientation need to be rotated 90deg CCW."_

Net effect: the +x run becomes a downward column, and CJK reads upright.

**Consequence worth stating explicitly:** in the point path, Latin letters are
also marked `vertical` (the truth table above), so they are counter-rotated too
and render **upright, one letter per cell**, not rotated sideways. That is
MapLibre's behaviour, and parity means reproducing it.

### 1.3 The line path is a different feature — explicitly OUT of D7

`symbol/symbol_layout.ts:222-224`:

```ts
if (allowsVerticalWritingMode(unformattedText) && textAlongLine && keepUpright) {
    shapedTextOrientations.vertical = shapeText(..., WritingMode.vertical, false, ...);
}
```

Note the condition: `keepUpright` and `textAlongLine` — **not**
`bucket.allowVerticalPlacement`, i.e. **not** `text-writing-mode`. The switch to
that variant happens per-frame from screen geometry
(`symbol/projection.ts:388-400`): a horizontal line label whose projected
`rise > run * aspectRatio` flips to `useVertical`.

X-GIS already reports `text-keep-upright` as `supported`
(`spec-coverage/layout-symbol.ts:128-132`, "Per-glyph flip for line labels"),
which covers the flip but not the verticalization. Whether that gap is worth
closing is a **separate item**; it must not be smuggled into D7, because it has a
different trigger, a different code path (`addCurvedLineLabel`), and no spec row
of its own. Recorded here so it is not rediscovered as "D7 is incomplete".

### 1.4 "Supports vertical" is a Unicode property, not a heuristic

`util/script_detection.ts:19-24` — `allowsVerticalWritingMode(chars)` is true if
**any** char has upright vertical orientation, sourced from generated Unicode
data (`util/unicode_properties.g.ts`, UAX#50 `Vertical_Orientation`). There is no
"CJK-dominant" ratio test anywhere in MapLibre. One ideograph in an otherwise
Latin string is enough.

---

## 2. What we are NOT doing

- **Line-placed vertical text** (§1.3) — different trigger, different path, own item.
- **Arabic / complex-script vertical** — MapLibre excludes it by construction
  (`isLineVertical`, the `charInComplexShapingScript` term). We exclude it identically.
- **Vertical icons / `icon-text-fit` against a vertical label** —
  `symbol_layout.ts:327-328` builds a `verticallyShapedIcon`; that is ADR-0012 **D3**.
- **Variable anchors crossed with vertical** — MapLibre's
  `placeBoxForVariableAnchors(verticalTextBox, …)` (`placement.ts:653`). X-GIS's
  `variableMode` already excludes itself from the layout cache
  (`text-stage.ts:1160-1164`); vertical labels take the same exclusion in P2 and
  the crossing is deferred.
- **Editing `compiler/src/convert/spec-coverage/` or `scripts/gap-matrix.md`
  before the final phase.** Four parallel tracks share that table; D7 touches it
  once, in P4.
- **Bumping any LOC ceiling.** The ratchet is shrink-only (§9).

---

## 3. The key observation: X-GIS already owns the primitive, and does not need the cancellation trick

`TextDraw` (`map/src/text/text-renderer-types.ts`) already carries:

| field                             | line  | meaning                                                                 |
| --------------------------------- | ----- | ----------------------------------------------------------------------- |
| `glyphOffsets?: Float32Array`     | `:46` | per-glyph `(dx, dy)` from the anchor; **bypasses the pen-advance loop** |
| `glyphRotations?: Float32Array`   | `:59` | per-glyph radians; when set, `rotateRad` is ignored                     |
| `rotateRad?: number`              | `:39` | whole-label rotation about the anchor                                   |
| `groundBasis?: ArrayLike<number>` | `:80` | #777 IV3 ground plane (§8)                                              |

and `text-renderer.ts:363-379` applies `glyphRotations` by rotating each quad
**around its own centre**:

```ts
const gcx = (x0 + x1) * 0.5 + (shTop + shBot) * 0.5,
  gcy = (y0 + y1) * 0.5
```

That combination is strictly more expressive than MapLibre's vertex format.
MapLibre _must_ lay out along +x and rotate the label, because its per-glyph data
is baked into a vertex buffer in shaping space with a single label angle
available at draw time. X-GIS composes `glyphOffsets` on the **CPU, per frame**
(`text-stage.ts:1340-1414`), so it can simply write the column directly:

> **The design.** For a vertical label, `glyphOffsets` advances in **+y** by the
> em pitch, and `glyphRotations[i]` is **0 for upright (verticalized) glyphs** and
> **+π/2 for glyphs that stay horizontal**. There is no label-level rotation and
> no cancelling pair.

This is the same _rendered_ result as MapLibre's model with one composition
removed. It is also the reason the ceiling risk is survivable: the change is
confined to how two arrays get filled, not to the renderer, the vertex format,
the shader, or the atlas.

### 3.1 Where it deliberately differs from MapLibre, and why that is acceptable

X-GIS rotates a glyph about its own quad centre; MapLibre rotates about
`(-halfAdvance, halfAdvance - SHAPING_DEFAULT_OFFSET)` and then re-translates by
`halfWidthOffsetCorrection` (§1.2c). The two are not the same map — MapLibre's
constants (`5 - SHAPING_DEFAULT_OFFSET - (ONE_EM/2 - halfAdvance)`) encode an
assumption that every glyph lives in a 24×24 em box at a single raster scale.

**X-GIS violates that assumption on purpose.** Its atlas mixes PBF glyphs baked at
the 24-px native reference with locally-rasterized Hangul at a DPR-scaled raster,
and the renderer carries a **per-glyph** `g.rasterFontSize`
(`text-renderer.ts:315-318`, comment: _"a bilingual label mixes both in one draw,
so the factor is per-glyph"_). Porting MapLibre's correction constants verbatim
would bake a single-raster assumption into the one engine that provably does not
hold it. We therefore reproduce the **geometry** (column pitch, upright
orientation, glyph order) and derive the centring from X-GIS's own per-glyph slot
metrics. §12's parity gate measures the result against MapLibre in pixels rather
than asserting constant-for-constant equality.

---

## 4. Socratic self-critique — the alternatives, and why each is rejected

### 4.1 Rotate the atlas entries instead of the quads — REJECTED

_Bake a pre-rotated SDF for each verticalized glyph into the atlas; draw
axis-aligned quads as today._

Rejected, four reasons, any one sufficient:

1. **It doubles glyph residency** for every codepoint that appears in both
   orientations, in an atlas that is already page-managed and evicted
   (`sdf/glyph-atlas-host.ts`, and its `*-stale-eviction` / `*-memo-bound` gates).
2. **SDF distance fields are not rotation-invariant under resampling.** A rotated
   re-raster resamples the distance field on a rotated grid; the byte-slope
   mismatch class this repo already paid for (`text-renderer.ts:325-334`, iter 114
   / iter 117) is exactly this failure mode.
3. **Halo geometry would become orientation-dependent.** Halo width/blur are
   uniform-side today (`halo-uniforms.test.ts`); an orientation-specific raster
   splits that authority.
4. **The atlas key would need an orientation term**, which is the same
   cache-collision hazard as §10 but one layer deeper and shared with the GPU
   page allocator.

### 4.2 Mirror MapLibre exactly — lay out along +x, rotate the label +90°, counter-rotate glyphs −90° — REJECTED

Rejected, two reasons:

1. **The renderer treats the two rotations as mutually exclusive.**
   `text-renderer.ts:363` is `if (perGlyphRot !== undefined) { … } else { rotateXY(…) }`
   — `rotateRad` is _not_ applied when `glyphRotations` is set (the comment at
   `:275-277` says so). Mirroring MapLibre needs both simultaneously, i.e.
   renderer surgery on the hot glyph loop, for no rendered difference.
2. **It imports constants whose premise X-GIS does not satisfy** — the per-glyph
   `rasterFontSize` argument in §3.1. A cancelling pair of rotations is also
   strictly harder to unit-test: the intermediate state is not observable, so a
   sign error in one half is only visible in final pixels.

### 4.3 A separate vertical code path in `TextStage` — REJECTED

_Add `addVerticalLabel()` beside `addLabel()` / `addCurvedLineLabel()`._

Rejected: it would duplicate collision submission, fade
(`label-fade.ts:230-241`), holdover reprojection (`holdover-reproject.ts`), the
layout cache, and the paired-shield path — and it would land in
`text-stage.ts`, which has **2 lines of headroom** (§9). Vertical is a different
_fill rule_ for two arrays, not a different lifecycle.

### 4.4 Per-glyph rotation in the shader — REJECTED

`TEXT_FORMAT` is `pos_px: float32x2` + `uv: float32x2`, **stride 16**
(`map/src/text/text-vertex-format.ts`), declared as the single source of truth
from which both the `GPUVertexBufferLayout` and the CPU packer derive. Adding a
per-vertex angle changes the format for every text draw in the engine, invalidates
the WGSL snapshot gates, and buys nothing: the CPU already computes the four
corners.

### 4.5 Skip `glyphRotations` and encode rotation as swapped UVs — REJECTED

A 90° rotation _can_ be expressed by permuting the four corner UVs. It is rejected
because it silently breaks the synthetic-oblique shear
(`text-renderer.ts:342-348`, applied per-corner in x relative to the baseline) and
the halo geometry, both of which assume a specific corner→UV correspondence.

---

## 5. Vertical metrics without `vhea` — the constraint, and the trap

PBF SDF glyphs carry only `advance`, `width`, `height`, `left`, `top`. There is
**no vertical origin and no vertical advance** in the format. Neither has MapLibre:
it substitutes a constant `ONE_EM` advance for verticalized glyphs
(`shaping.ts:386`) and centres the glyph in the em cell from the _slot_ geometry
(`quads.ts:262-266`).

X-GIS already shares both constants with MapLibre — `ONE_EM` and
`SHAPING_DEFAULT_OFFSET` are exported from `map/src/index.ts:192-193` and consumed
in `text-stage.ts:60-61,1382`, and `text-vertical.test.ts` already pins X-GIS's
multi-line box to MapLibre's `shapeLines` + `align()` formula. So the constants are
not a new import; only their use along the cross axis is new.

> **THE TRAP — do not derive vertical centring from `bearingY`.**
> This has bitten this repo before — the fix is recorded as _"correct latin PBF
> glyph bearingY convention — bilingual collapse"_ (CHANGELOG.md:1856, iter 333),
> and the regression is pinned by `map/src/text/sdf/pbf-glyph-bearingy.test.ts`
> and `map/src/text/bilingual-label-placement-repro.test.ts`. The prior research
> note flags it HIGH for exactly this feature
> (`docs/research/2026-06-19-mapbox-compat-roadmap.md:83`). `bearingY` is an
> **ink** metric: it differs between Latin and Hangul for the same nominal size,
> so a bilingual vertical column centred on `bearingY` would zig-zag on the cross
> axis. The column pitch and the cross-axis centre must come from the **em box and
> the slot size** (`g.slot.size`, `g.rasterFontSize`), never from `bearingY`.

**Invariant to encode as a test (P2):** for a vertical label, the cross-axis
offset of every glyph is a function of `slot.size`, `rasterFontSize` and
`fontSize` only. Concretely: a bilingual vertical label `"東A京"` must have all
three glyphs on the same cross-axis centreline, and the column pitch must be
constant `ONE_EM * fontSize / ONE_EM + letterSpacingPx` regardless of the
per-glyph `metrics.advance`. That test fails today for the trivial reason that
vertical labels do not exist; it must be re-pointed at the bearingY hazard
specifically once they do (see the anti-vacuity note in §12).

---

## 6. Mixed-script runs and punctuation

Mixed runs are governed by the §1.2(a) truth table, which we reproduce exactly:
in the point path everything verticalizes **except whitespace and
complex-shaping scripts**. Latin therefore renders upright-stacked. Design
decision: **match MapLibre**, and say so in the spec-coverage note, because a
"nicer" choice (rotating Latin sideways, as CSS `text-orientation: mixed` would)
is a visible parity divergence on every bilingual style.

**Punctuation** is the one genuinely separable sub-feature.
`shaping.ts:127-128` calls `logicalInput.verticalizePunctuation()`
(`symbol/tagged_string.ts:212-213`, delegating to `util/verticalize_punctuation.ts`),
which maps a small set of codepoints to their
vertical presentation forms (e.g. `、。「」（）` → U+FE10 block). Options:

- **(i)** Implement the mapping table in P3.
- **(ii)** Ship P2 without it and emit a precise warning.

Chosen: **(i), scheduled as its own phase (P3)**, so P2 can land and be pixel-verified
on punctuation-free fixtures (`서울특별시`, `東京都`) first. If P3 slips, (ii) is the
documented fallback and the spec-coverage row stays `partial` rather than
`supported` — ADR-0012 §1 explicitly permits `partial` **with a warning-backed
degradation note**, and forbids the silent drop.

---

## 7. Collision box orientation

MapLibre builds a **separate** `CollisionFeature` for the vertical variant, rotated
by +90° (`symbol_layout.ts:549-551`), and the placement loop chooses between the
horizontal and vertical boxes (`placement.ts:561,653,904`), hiding the loser
(`placement.ts:1094-1095`).

X-GIS does not need the second box **if** the bbox is derived from `glyphOffsets`
rather than from a text-extent estimate — because in the design of §3 the offsets
already describe the column. That is a claim about existing code, not an
assumption: `map/src/text/derive-label-bbox.test.ts` and
`map/src/text/paired-symbol-box.ts` are the authorities, and **P2's first task is
to confirm the derivation path is offsets-driven end to end.** If any consumer
recomputes an extent from `totalAdvance` (which `text-stage.ts:245-246` lists
alongside `glyphOffsets` in the cache entry), that consumer is the real work item
and must be fixed rather than worked around — a collision box that stays wide-and-short
under a tall-and-narrow label is the kind of gate-passing-but-wrong outcome
CLAUDE.md §12 catalogues.

Since D7 ships a **single** orientation per label (the style's array is read for
whether `vertical` is present, §11), the horizontal/vertical _arbitration_ MapLibre
performs is out of scope; the label is laid out vertically or it is not.

---

## 8. Interaction with D1 (`text-pitch-alignment` ground projection)

> **Correction to the track brief.** D1's ground basis is **already landed on
> `main`**, not pending. `map/src/text/ground-basis.ts` exists at `origin/main`
> (`f0e89d8`), headed _"#777 IV3 — the ground basis for `text-pitch-alignment: map`"_,
> with `map/src/text/ground-basis.test.ts` and
> `map/src/text/text-ground-basis-wiring.test.ts` beside it, and it is consumed in
> `text-renderer.ts:269-274,384+`. The pre-implementation "has D1 merged yet?" check
> still applies for _follow-up_ D1 work, but the shape to rebase onto exists today
> and this design is written against it.

**Exactly where the two features touch — one place:** the glyph loop of
`text-renderer.ts`. The order is already correct for us:

```
x0,y0,x1,y1  →  rotation (per-glyph OR whole-label)  →  groundBasis re-expression
                └── text-renderer.ts:355-379            └── text-renderer.ts:381-400+
```

`text-renderer.ts:380-386` states the ordering rationale: the ground basis is
applied **after** rotation _"so the label's in-plane angle … is what gets
projected — rotating a foreshortened quad would shear it instead."_ Vertical
writing contributes only in-plane angles (0 or π/2) through the existing
`glyphRotations` branch, so it inherits that ordering for free.

**They are separable**: D7 changes only what fills `glyphOffsets` and
`glyphRotations` in `text-stage.ts`; D1 changes how the renderer re-expresses the
resulting corners. Neither reads the other's inputs.

**The one merge hazard**, recorded so it is not rediscovered: both features write
into the same eight corner locals (`tlx…try_`) in the same ~45-line block. A D1
follow-up that restructures that block will conflict textually with nothing D7
does _today_ (D7 adds no lines there), but any future D7 change to the rotation
branch must re-read the block rather than patching from this doc.

---

## 9. LOC ceiling risk table

Ratchet: `map/src/loc-ceiling-ratchet.test.ts` — shrink-only high-water marks;
non-baselined files must stay under `NEW_FILE_CAP = 800` (`:40`). Ceilings are
**measured after the prettier pre-commit hook**, via `git show HEAD:<file> | wc -l`
(CLAUDE.md §12).

| file                                     | HEAD LOC |     ceiling | headroom | risk         | plan                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | -------: | ----------: | -------: | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map/src/text/text-stage.ts`             |     2185 |    **2187** |    **2** | **CRITICAL** | Add **zero** net lines. Vertical layout lives in a new `map/src/text/vertical-writing.ts`; the call site must be a net-zero swap. If it cannot be, extract the existing horizontal pen loop (`:1340-1414`) into the same new module so `text-stage.ts` **shrinks** and the ceiling is **lowered**. |
| `compiler/src/ir/lower-label.ts`         |     1190 |    **1190** |    **0** | **CRITICAL** | The `writingMode` knob decl cannot be added without an equal extraction. Precedent for a knob-decl extraction exists in the same file (`:1145-1187` history). Budget this as real work in P1, not a one-liner.                                                                                     |
| `compiler/src/convert/layers-symbol.ts`  |     1342 |        1357 |       15 | MEDIUM       | P1 is a warn→emit **swap**: delete the ~12-line gap-warning block (`:493-514`) and add the emit. Precedent: the same file did exactly this for `icon-text-fit` (`:1829` ratchet comment). Net should be ≈0; measure, do not assume.                                                                |
| `map/src/text/text-renderer.ts`          |      713 | — (cap 800) |       87 | LOW          | D7 adds nothing here by design (§3).                                                                                                                                                                                                                                                               |
| `map/src/text/text-stage-helpers.ts`     |      707 | — (cap 800) |       93 | LOW          | `layoutCacheKey` gains one parameter (§10): +2–3 lines.                                                                                                                                                                                                                                            |
| `map/src/text/vertical-writing.ts` (new) |        0 | — (cap 800) |      800 | LOW          | Where the work goes.                                                                                                                                                                                                                                                                               |

**The ratchet rule for this track: extract, never bump.** Two of the six files are
at or within two lines of their ceiling, which makes the extraction _the_ schedule
risk in P1/P2 — larger than the rotation math.

---

## 10. The layout-cache collision — HIGH, and the fix has a precedent

`layoutCacheKey` (`map/src/text/text-stage-helpers.ts:199-219`) hashes
`glyphsKey, sizePx, letterSpacingPx, maxWidthPx, lineHeightPx, justify, anchor,
offsetX, offsetY, translateX, translateY, padding, haloWidth, haloBlur, paired`.

**There is no writing-mode term.** Two labels with identical font, text, size,
anchor, halo and offsets — one horizontal, one vertical — hash to the same key and
alias to one another's `glyphOffsets`. Whichever is laid out first wins, and the
other renders in the wrong orientation with no error anywhere.

The fix is the exact shape of the `paired: boolean` term added for #608-scope,
whose comment (`:214-218`) describes the identical hazard: _"Same font/text/size/anchor
but different glyphOffsets, so the two must NOT share a cache entry."_ Add a
`vertical: boolean` term the same way.

**Fail-before witness (P2), and it must go red for the right reason:** lay out the
same string twice at the same size/anchor, once horizontal and once vertical;
assert the two `glyphOffsets` arrays differ. Before the key term is added this
fails as an _aliasing_ equality — which is the bug — and the assertion message must
say so, not merely "arrays equal".

---

## 11. Two landmines found while reading

### 11.1 `glyphRotations` currently _means_ "curved"

`map/src/text/text-stage-diagnostics.ts:187` defines:

```ts
curved: d.glyphRotations !== undefined,
```

Today that is sound, because only `addCurvedLineLabel` writes the array
(`text-stage.ts:1651-1704,1750`). The moment point labels set `glyphRotations`
for vertical text, **every vertical point label is reported as a curved line
label** — in diagnostics that other gates and the playground overlay read. P2 must
replace the proxy with an explicit discriminator. This is a silent
mis-attribution, not a crash, which is why it is written down here.

### 11.2 `LabelDef.writingMode` already exists and is wired to nothing

`compiler/src/ir/render-node.ts:607` declares
`writingMode?: 'horizontal' | 'vertical'` with the comment _"CJK vertical text.
Batch 1g+."_ A repo-wide search for non-test consumers returns **only** that
declaration and the converter's warn-and-drop block
(`layers-symbol.ts:506-514`). Nothing produces it; nothing reads it.

So the field is a **dangling contract**, not a partial implementation. P1 wires it
end to end; no existing behaviour depends on it, which is what makes P1's
byte-identity invariant (ADR-0012 §4.3) trivially satisfiable for styles that do
not author the property.

---

## 12. Phases

Each phase: **GitHub issue first** (CLAUDE.md §9.5) → fail-before corpus proven red
for the right reason → implement → **full local gate, sequential** (`bun run build`
then `bun run test`, never concurrent — CLAUDE.md §7) → **draft PR**.

Before each _implementation_ phase: `git fetch origin main` and merge, then
re-verify §8's landed-D1 claim against the code rather than against this doc
(CLAUDE.md §12, "plan docs drift from landed reality").

### P0 — this design doc

Draft PR, no code. Exit: doc lands on `claude/t4-cjk-vertical-text`.

### P1 — converter + IR wiring (no pixels)

`text-writing-mode` → utility → `LabelDef.writingMode`; delete the gap warning.
Array semantics: the style value is an ordered priority list, but D7 ships one
orientation, so the rule is **`'vertical'` present ⇒ `writingMode: 'vertical'`**,
and `['horizontal']` / absent ⇒ unset (byte-identical). Ordering within the array
is not yet honoured — that is a `partial` note, not a silent drop.

- **Fail-before**: extend `compiler/src/__tests__/text-writing-mode-max-angle-warn.test.ts`'s
  three existing cases — they currently assert the warning **exists**, so they go
  red by construction when it is removed, and must be rewritten to assert the
  **emit** instead. New: `text-writing-mode-convert.test.ts` asserting
  `LabelDef.writingMode === 'vertical'`.
- **Byte-identity**: the 9-style snapshot harness must stay byte-identical (none
  of the audited styles authors the property).
- **LOC**: the `lower-label.ts` zero-headroom extraction (§9) is in this phase.
- **Verification**: build + vitest. No GPU — no pixel changes.

### P2 — layout: the column, the cache key, the bbox

New `map/src/text/vertical-writing.ts`; `glyphOffsets` in +y at em pitch;
`glyphRotations` 0/+π/2 per the §1.2(a) table; `layoutCacheKey` gains `vertical`
(§10); diagnostics discriminator (§11.1); bbox derivation confirmed offsets-driven
(§7).

- **Fail-before**: (a) the cache-aliasing witness of §10; (b) the bilingual
  cross-axis invariant of §5; (c) column order and pitch for `서울특별시`.
- **§5 real-GPU verification** — required, this phase changes pixels:
  ```
  cd playground && XGIS_SOFTWARE_GPU=1 HEADED=0 \
    XGIS_CHROMIUM_EXECUTABLE=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell | head -1) \
    ./node_modules/.bin/playwright test <spec>
  ```
  Fixtures: `서울특별시` (Hangul), `東京都` (Han), `Tokyo 東京` (mixed). Read the
  frame as a **16-split (4×4) grid at full resolution** (`tile-crop-review`),
  worst tiles first; directional diff via
  `.claude/skills/compare-parity-pixeldiff/compare-diff.py`, gated on **DC>0 and
  D1<D0**, never an absolute percentage. A downscaled glance is not verification.
- **Anti-vacuity cut** (CLAUDE.md §12, _"the assertion that failed either way"_):
  it is not enough that the fail-before goes red. **Sever the `glyphRotations`
  write specifically** (leave the offsets correct) and confirm the failing message
  names the _orientation_, not the column; then sever the offsets write and confirm
  it names the _column_. One cut only ever proves one message.

### P3 — punctuation + the upright table

`verticalizePunctuation` equivalent (§6) and the UAX#50 upright-orientation
predicate as a data table rather than a range heuristic. Same verification
posture, fixtures gain `「東京」、`.

### P4 — FINAL: spec-coverage + gap-matrix (the only phase that touches the shared table)

Flip the `text-writing-mode` row to `supported` (or `partial` with the §6(ii)
note if P3 slipped). Per CLAUDE.md §12 this is a **three-way sync**: the
spec-coverage row + a regenerated `scripts/gap-matrix.md` + a `RUNTIME_CAPABILITIES`
row, or the drift gate `spec-coverage-runtime-drift.test.ts` breaches its
<3-orphan allowance. Regenerate, do not hand-edit:
`bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md` (emits to **stdout** by
contract — exit 0 ≠ file written).

---

## 13. Risks

| risk                                              | severity | mitigation                                                        |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| `text-stage.ts` / `lower-label.ts` at ceiling     | **HIGH** | §9 — extraction is scheduled work in P1/P2, not a cleanup         |
| Layout-cache aliasing (§10)                       | **HIGH** | key term + fail-before witness that fails as an aliasing equality |
| `bearingY` used for cross-axis centring (§5)      | **HIGH** | invariant test on a bilingual column; documented prior incident   |
| `glyphRotations`-means-curved diagnostics (§11.1) | MEDIUM   | explicit discriminator in P2                                      |
| bbox not offsets-driven (§7)                      | MEDIUM   | P2 task 1 is to confirm, and to fix rather than work around       |
| Latin-upright reads as a bug to a reviewer        | LOW      | §6 — documented parity decision, stated in the spec-coverage note |
| Full-suite 30s-timeout load flakes                | LOW      | issue **#1991** protocol; adjudicate, never chase                 |

---

## 14. Open decisions

1. **P3 scope** — full `verticalizePunctuation` table, or the `partial` + warning
   fallback of §6(ii)? Decidable after P2 measures how much of the parity diff
   punctuation actually accounts for.
2. **Ordered-array semantics** — D7 reads the array as a set (§P1). Honouring
   priority order requires the horizontal/vertical arbitration of §7, which is a
   larger item. Recorded as a deliberate `partial`, not an oversight.
3. **Line-placed vertical (§1.3)** — worth its own ADR-0012 item, or intentionally
   out of scope forever? Not D7 either way.
