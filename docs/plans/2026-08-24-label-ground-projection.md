# Ground-projected labels — `text-pitch-alignment: map` (ADR-0012 Phase D1)

Design document. **No production code.** Written against `origin/main` @ `f0e89d8`; every
`file:line` below was read at that commit.

ADR-0012 §3 names D1 "the highest-frequency gap (42 warnings across 9/9 audited styles;
every line-placed label resolves to `map`)". This document says what is actually already
built, where the value dies, what the ground plane means on each of the three projection
spaces the engine renders, and how the remaining work is cut into increments that each
have a gate that can fail.

Held to CLAUDE.md §2 (right-sized), §5 (a render claim needs a real gate that
distinguishes), §9.5 (record the constraint and the rejected approach WITH its reason),
and ADR-0004 (verification tiers). Prior art mined: `2026-07-27-arrow-pitch-alignment.md`
(the sibling problem, solved for the retained arrow primitive) and
`2026-07-27-line-label-world-anchored-placement.md` (whose §3.2 prefix-sum mapping is
reused verbatim below).

---

## 1. The current mechanism, and exactly where the value dies

### 1.1 The converter half is complete, and its authority is shared

`text-pitch-alignment` resolves through a two-step spec chain that routes styles into
`map` **by default**:

```
text-rotation-alignment: auto  →  map      for line / line-center placement
                                  viewport for point placement
text-pitch-alignment:    auto  →  whatever text-rotation-alignment resolved to
```

That chain has ONE implementation — `compiler/src/ir/label-alignment.ts:35-56`
(`resolveRotationAlignment` / `resolvePitchAlignment`), exported through
`compiler/src/ir/index.ts:95-102` — and it already has two consumers that must not drift:
the converter's runtime-gap warning (`compiler/src/convert/layers-helpers.ts:567-589`,
called from `compiler/src/convert/layers-symbol.ts:1255-1256`) and the runtime producer
(`map/src/render/passes/dispatch-point-labels.ts:104`). The emit path is
`layers-symbol.ts:1245-1252` → `label-pitch-alignment-{map,viewport,auto}` →
`compiler/src/ir/lower-label.ts:507-518` → `lower-label.ts:1086-1088` →
`LabelDef.pitchAlignment` (`compiler/src/ir/render-node.ts:593`).

Nothing on this side needs to change. §1.5 lists the documentation that does.

### 1.2 Which layers the chain actually selects — MEASURED, not assumed

Resolved over the two style fixtures in the tree
(`playground/e2e/__convert-fixtures/{bright,liberty}.json`), 25 symbol layers each:

| layer                   | placement  | `text-rotation-alignment` | resolves to | X-GIS branch      |
| ----------------------- | ---------- | ------------------------- | ----------- | ----------------- |
| `waterway_line_label`   | line       | (auto)                    | **map**     | curved            |
| `water_name_line_label` | line       | (auto)                    | **map**     | curved            |
| `highway-name-path`     | line       | map                       | **map**     | curved            |
| `highway-name-minor`    | line       | map                       | **map**     | curved            |
| `highway-name-major`    | line       | map                       | **map**     | curved            |
| `highway-shield-*` ×3   | step-expr¹ | **viewport**              | viewport    | straight          |
| `road_oneway` ×2        | line       | (auto)                    | map         | — (no text-field) |
| the other 15            | point      | (auto)                    | viewport    | point             |

¹ `["step", ["zoom"], "point", 11, "line"]`. This is **not** a hidden gap — it was checked:
`parseSymbolPlacementStep` (`compiler/src/convert/layers-helpers.ts:483-510`) splits such a
layer into one xgis layer per zoom range and feeds each a constant `overrides.placement`
(`layers-symbol.ts:1104-1109`), so the ≥z11 sub-layer really is line-placed. The shields stay
billboards because of their **explicit** `text-rotation-alignment: viewport`, not because the
placement is misread.

**Three facts fall out of this table, and each one changes the plan:**

1. **100 % of the resolving layers take the CURVED (tangent-rotated) branch**
   (`label-pass.ts:1244` — `useTangentRotation = lineRotAlign !== 'viewport'`). The
   straight along-line branch has **zero** resolving layers on either style.
2. **The along-line shields are NOT in the set.** They author
   `text-rotation-alignment: viewport`, so `resolvePitchAlignment` returns `viewport` and
   they must keep billboarding. The spec-coverage note claiming otherwise is wrong (§1.5).
3. The `road_oneway` pair is icon-only, correctly excluded by the warning's
   `isOmittedValue(layout['text-field'])` guard (`layers-helpers.ts:577`) — their gap is
   `icon-pitch-alignment` (ADR-0012 D3).

A corollary worth stating before anyone writes a gate: **a render gate pointed at a real
basemap that exercises only the straight branch will measure a no-op and call it a pass.**
That is the vacuity CLAUDE.md §5 exists to prevent, and the fixture
`playground/src/examples/fixture-label-pitch-alignment.xgis` was purpose-built for the same
reason — its own header says so.

### 1.3 The runtime half is a complete chain wired at ONE of five dispatch sites

This is the finding that reframes D1. `LabelDef.pitchAlignment` is **not** unconsumed — the
whole downstream chain landed with #777 IV3 (#1442 / #1462 / #1471 / #1492):

| stage                  | where                                                          | state |
| ---------------------- | -------------------------------------------------------------- | ----- |
| pitch-0 inverse matrix | `map/src/camera/pitch0-unproject.ts:80-133`                    | built |
| basis derivation       | `map/src/text/ground-basis.ts:80-137` (`groundBasisAt`)        | built |
| producer + spec gate   | `map/src/render/passes/dispatch-point-labels.ts:74-120`        | built |
| producer construction  | `map/src/render/passes/label-pass.ts:645-650`                  | built |
| stage carries it       | `text-stage.ts:727,768`; `text-stage-types.ts:141-153`         | built |
| collision box uses it  | `text-stage-helpers.ts:685-707` → `ground-basis.ts:153-186`    | built |
| drawn quad uses it     | `text-renderer.ts:269-274, 385-412`                            | built |
| diagnostic             | `text-renderer.ts:198-201`; `map/src/diagnostics.ts:90-94,239` | built |
| §5 acceptance gate     | `playground/e2e/_label-pitch-alignment-gate.spec.ts`           | green |

**And it is fed from exactly one call site: `label-pass.ts:1152-1162`** — Path 1 (GeoJSON /
`host.rawDatasets`), non-line geometry only. The graph agrees: `groundBasisAt` has
`callers_total: 2` (`makeGroundBasisFor`, and `LabelPass.execute` transitively) and nothing
else.

The four dispatch sites that drop it:

| #   | site                      | path                               | what it emits                    |
| --- | ------------------------- | ---------------------------------- | -------------------------------- |
| A   | `label-pass.ts:1821-1832` | VT point, non-mercator projections | `stage.addLabel(… ps)` — 10 args |
| B   | `label-pass.ts:1865-1876` | VT point, mercator                 | `stage.addLabel(… ps)` — 10 args |
| C   | `label-pass.ts:1273-1274` | VT/inline line, straight branch    | `stage.addLabel(… pk)` — 8 args  |
| D   | `label-pass.ts:1634-1650` | VT line, **curved branch**         | `stage.addCurvedLineLabel(…)`    |

`addLabel`'s `groundBasis` is parameter 11 (`text-stage.ts:727`), so A–C are not "passing
undefined" — they end before the parameter exists. C cannot even reach it: its dependency
signature stops at `pairKey` (`place-labels-along-line.ts:279-288`), as does
`placeInlineLineLabels`'s at `layerName` (`:401-410`). D is worse than unwired — see §1.4(c).

**This is #1081's trap, exactly.** That feature also wired Path 1 and left Path 2 dry, and
the symptom was a pixel diff of 0.000 % against main — "the feature was inert for vector
tiles". The autopsy and its structural guard are in
`map/src/render/passes/label-pass-vt-perspective-wiring.test.ts:1-23`. Any D1 increment that
touches a dispatch site owes a guard in that file's style.

### 1.4 Three defects in the landed producer, found while tracing

**(a) The basis is evaluated at the wrong ground point.** `groundBasisAt` takes the label's
SCREEN anchor and unprojects it with the **pitch-0** inverse
(`ground-basis.ts:91-96`), so the ground point `G` it linearizes about is "the point that
would be at that pixel if pitch were 0" — not `G_live = unproject_live(ax, ay)`, which is
where the label actually is. The renderer then applies the resulting Jacobian pivoted on the
LIVE anchor (`text-renderer.ts:394-411`). At the screen centre the two ground points coincide
and the basis is exact; away from it they diverge, and the divergence grows with pitch
because the pitch-0 image of the far field is compressed into a narrow band. The far-field
labels — the ones ground projection is most visible on — get the least correct basis.

**(b) projType 3/4/5/7 get no basis at all, because of an inverse that does not exist.**
`ground-basis.ts:33-40` and `pitch0-unproject.ts:22-26` both document this as deliberate:
`unprojectToLonLat` returns `null` for the azimuthal discs and the globe
(`map/src/camera/unproject.ts:98-99`, `:147` — "Flat non-merc set only (equirectangular 1 /
natural_earth 2 / oblique_mercator 6). Disc (3/4/5) + globe (7) are out of scope"), so the
producer returns `undefined` and the label billboards. The rationale given — that a
per-projection analytic fallback would be a second authority — is right. The conclusion that
therefore those projections cannot have a basis is **not**: the construction needs a
normalizer, not an inverse (§3.1).

**(c) The curved path's renderer contract makes the existing transform unusable.** A curved
label sets `anchorX: 0, anchorY: 0` and writes ABSOLUTE screen coordinates into
`glyphOffsets` (`text-stage.ts:1726-1729, 1740-1741`), because the renderer computes
`baseX = d.anchorX + offsets[gi*2]` (`text-renderer.ts:324-325`). The basis transform pivots
on `d.anchorX/anchorY` (`text-renderer.ts:394-395`). Attaching a basis to a curved draw today
would therefore pivot the whole road label around **screen pixel (0, 0)**. `PendingLineLabel`
has no `groundBasis` field at all (`text-stage-types.ts`, the interface after
`PendingLabel`), so this is latent rather than live — but it is the reason D is not a
one-line wiring change.

### 1.5 The status record is stale, and one line of it is wrong

- `compiler/src/convert/spec-coverage/layout-symbol.ts:124` and its regenerated row in
  `scripts/gap-matrix.md:47` state "`LabelDef.pitchAlignment` has **NO** consumer in
  map/src" — false since #777 IV3 landed the point path.
- The same note lists "along-line shields" among the affected layers. §1.2 measures them
  resolving to `viewport`. The affected set is road names + waterway names.
- `map/src/capabilities/symbol.ts:30-35` says "Runtime never projects labels onto ground
  plane" — also stale.

ADR-0012 §1 makes the coverage table + gap-matrix + capabilities the single live status
authority. Correcting all three is part of D1, not a follow-up.

---

## 2. What MapLibre actually does (read, not remembered)

Read from `maplibre-gl@5.24.0` in `node_modules`. Four mechanisms, and X-GIS diverges from
each in a different way.

**(1) The label plane.** For `pitch-alignment: map`, MapLibre lays symbols out in a _label
plane_ that is the rotated map plane in pixels, then projects each laid-out point to clip
space; for `viewport` the label plane IS the screen
(`src/symbol/projection.ts:102-121` `getPitchedLabelPlaneMatrix`, `:124-146`
`getGlCoordMatrix`, `:672-681` `projectTileCoordinatesToLabelPlane`). For line symbols the
per-glyph walk itself runs in that plane and re-runs every frame
(`:216` `updateLineLabels`, `:432` `placeGlyphsAlongLine`). **X-GIS walks the SCREEN-projected
polyline** (`label-pass.ts:1440-1472` fills `_pxScratch/_pyScratch`; `text-stage.ts:1563-1643`
walks them). That is the core structural difference, and it is why D (§1.3) is a design
problem and not plumbing.

**(2) Sizing.** `src/shaders/glsl/symbol_sdf.vertex.glsl:93-101`:

```glsl
distance_ratio = u_pitch_with_map ? camera_to_anchor / camera_to_center
                                  : camera_to_center / camera_to_anchor;
perspective_ratio = clamp(0.5 + 0.5 * distance_ratio, 0.0, 4.0);
size *= perspective_ratio;
```

The map branch is the **reciprocal** of the viewport branch: it GROWS the label-plane size
with distance so the subsequent perspective divide does not shrink the label to nothing. Net
screen size tends to `0.5 ×` base as distance → ∞, not to 0. X-GIS has the viewport branch
(`render-loop-helpers.ts:612` — `clamp(0.5 + 0.5·wCenter/cw, 0.5, 1.0)`, #1081) and
deliberately forces the map branch to 1 (`text-stage.ts:1024`). So an X-GIS ground-projected
label foreshortens **fully**, and a far road name shrinks past legibility where MapLibre's
holds at half size.

**(3) Collision.** `src/symbol/collision_index.ts:544-548` picks east/south skew vectors from
`getTileSkewVectors`, `:558-577` scales the box by
`2^-zoomFraction · pitchedTextCorrection · perspectiveRatio`, `:597-616` builds **8** boundary
points of the box in the label plane, and `:621-627` projects all 8 and takes the screen AABB.
So: **the collision footprint is a screen-space AABB, but it is the AABB of the ground-plane
box's projected outline, not of the upright box.** X-GIS's `groundBasisAabb`
(`ground-basis.ts:153-186`) is the same idea with 4 corners and one affine basis instead of 8
points and a per-point perspective divide. Direction agrees; the residual is linearization
error, which is negligible for a point label and is NOT negligible for a road name spanning
several hundred pixels of a pitch gradient.

**(4) Horizon.** Two gates, both absent in X-GIS's flat path:
`collision_index.ts:100` sets `perspectiveRatioCutoff = 0.6` and `:165` drops any symbol below
it (i.e. anchor distance > 5 × camera-to-centre distance); `:162` additionally drops a
map-pitch-aligned symbol whose entire box projects behind the horizon.

---

## 3. Design

### 3.1 One authority, forward-only: the Jacobian-ratio basis

Keep the existing definition of the basis — "the screen-space images of the anchor's ground
axes, normalized so an unpitched camera yields exactly `[1,0,0,1]`"
(`ground-basis.ts:47-51`) — and keep the reason it is a composition rather than a closed form
(`ground-basis.ts:10-31`: any analytic divisor is right for one projection and quietly wrong
for the rest). **Change only how the composition is taken.**

Today: `basis = J[project_live ∘ unproject_pitch0]` at the SCREEN anchor.
Proposed: the same object, taken as a ratio of two forward Jacobians at the label's OWN
ground point `(lon, lat)`, which every dispatch site already holds:

```
J_live = [ P(lon+δ, lat) − P(lon, lat) ,  P(lon, lat+δ) − P(lon, lat) ] / δ
J_0    = [ P₀(lon+δ, lat) − P₀(lon, lat), P₀(lon, lat+δ) − P₀(lon, lat) ] / δ
basis  = J_live · J_0⁻¹                                          (a 2×2 solve)
```

`P` is the live label projector; `P₀` is the SAME projector built against the pitch-0 matrix
`Pitch0Unprojector` already constructs and currently only inverts
(`pitch0-unproject.ts:119`). Four properties, each of which is why this is the right shape:

- **No inverse anywhere**, so projType 3/4/5 (and, when their semantics are settled, 7) are
  in scope with **no per-projection branch** — defect §1.4(b) dissolves rather than being
  patched.
- **Identity at pitch 0 by construction.** At pitch 0, `P ≡ P₀` (same matrix, same code
  path) ⇒ `J_live = J_0` ⇒ `basis = I` exactly, at every bearing, latitude and projection —
  the same "the map composed with its own inverse" argument the current header makes, just
  taken one derivative up.
- **δ cancels to first order.** It is purely a linearization radius; it does not have to be
  calibrated against a screen scale, which removes `probePxFor`'s approximation
  (`dispatch-point-labels.ts:39-59`) entirely.
- **Evaluated where the label is** — defect §1.4(a) dissolves too.

Two hazards that MUST be designed in, because each one silently produces a correct-looking
inert feature:

- **`P₀` must have the culls off.** The live `projectLonLat` returns `null` outside an NDC
  ±1.5 window (`render-loop-helpers.ts:615`), past the globe horizon (`:601-603`), and inside
  the limb inset (`:623-633`). A far-field anchor that is on screen under pitch 60 is far
  off-screen at pitch 0, so a culled `P₀` returns `null` for exactly the labels the feature
  exists for, and the far field billboards while the near field works. That reads as "the
  basis is subtle", not as "the basis is missing".
- **Both projectors return a REUSED scratch tuple.** `ground-basis.ts:98-109` already
  records what that cost (#1471 + #1492 shipped inert on main because three tuples aliased to
  one). Six projections instead of three doubles the number of places to get it wrong; read
  each into scalars immediately.

Cost: 6 forward projections per basis, against 3 unprojections + 3 projections today —
unchanged. The `pitch > 0` short-circuit (`dispatch-point-labels.ts:100`) stays, and stays
justified by the same measurement (an f32 round trip returns the identity off by up to
1.995e-6, ~2000× `isIdentityBasis`'s epsilon — widening the epsilon to straddle that is the
tripwire, reading the camera is exact).

### 3.2 The ground plane, per projection space

**Flat Mercator (projType 0) and the flat non-merc set (1, 2, 6).** The map IS the plane
`z = 0`; the camera tilts about it. "The ground plane" is unambiguous, pitch-0 identity is a
theorem, and the basis carries exactly the pitch tilt plus the bearing rotation. Nothing new.

**Azimuthal discs (3, 4, 5).** These render on the _flat display path_ — the sphere is
projected to a 2D disc which is then laid on `z = 0` (`render-loop-helpers.ts:668-670`, "Flat
display path (projType 0-6)"). So the map plane is the disc, and the correct behaviour is the
same as Mercator's: at pitch 0 nothing moves, under pitch the disc tilts. The projection's own
limb compression is a property of the MAP, not of the camera — a printed azimuthal map has it,
and text printed on that map is not foreshortened by it. **The discs need no new semantics at
all; they were excluded only by the unprojector's `projType !== 1 && !== 2 && !== 6` guard**
(`unproject.ts:98`), which §3.1 removes. Ortho's existing rim-label margin
(`ORTHO_RIM_LABEL_MARGIN = 0.15`, `render-loop-helpers.ts:680`) already trims the band where
this would look worst.

**ECEF globe (projType 7).** Genuinely different, and **deliberately deferred** — the reason
is recorded here so it is not re-derived. On the globe there is no map plane: the map is the
sphere, and the label's ground plane is the _tangent plane at the anchor_, which is already
foreshortened at pitch 0 for any anchor away from the sub-camera point. MapLibre renders that
tilt (`symbol_sdf.vertex.glsl:135-145`, the `GLOBE` + `u_pitch_with_map` branch projects the
laid-out quad through the globe projection). Applying §3.1 verbatim to the globe gives a basis
carrying _only the pitch delta_, because `P₀` is the globe at pitch 0 and the curvature tilt is
not pitch. That is a bounded approximation, and the bound has a shape: the missing factor is the
cosine between the anchor's surface normal and the view ray, which is 1 at the sub-camera point
and falls off only as the anchor approaches the limb — where the label pass already culls hard
(`LABEL_HORIZON_MARGIN = 0.15` + `LABEL_LIMB_INSET_PX = 7`, `render-loop-helpers.ts:308,331`,
applied at `:601-603` and `:623-633`). Whether the surviving band is wide enough to matter is
NEEDS-PROBE 8; it is a measurement, not a guess. Making it exact instead requires choosing a
reference frame for a plane that has no unpitched image, which interacts with ADR-0002's
sphere-camera / ellipsoid-vertex split and is a decision of its own. **D1 ships flat 0–6; the
globe keeps billboarding, which is what it does today** — the coverage row therefore lands as
`supported` for the flat set with a precise degradation note for projType 7, which ADR-0012 §1
explicitly permits, rather than as an unqualified `supported`.

### 3.3 Screen-px glyph sizing under ground projection

`text-stage.ts:1024` currently reads `perspScale = p.groundBasis !== undefined ? 1 : …`, and
`text-stage-types.ts:148-152` justifies the exclusion: perspectiveScale and the basis "both
express the same distance attenuation", so applying both shrinks a far label twice.

That is right about double-counting and wrong about the remedy, and §2(2) is the evidence:
MapLibre applies a size multiplier in the map case too — it is simply the _other_ branch,
`clamp(0.5 + 0.5·(cw/wCenter), 0.0, 4.0)`, which grows where #1081's shrinks. Forcing 1 is
neither branch, and it leaves X-GIS's ground-projected labels smaller in the far field than the
reference by the full perspective factor.

**Decision: sizing is `map`-branch, not "off".** Under a basis, `sizePx` multiplies by the
reciprocal-argument twin of #1081's factor. Two consequences to design for:

- The projector must expose the **unclamped** ratio. `render-loop-helpers.ts:612` clamps to
  `[0.5, 1.0]`, which destroys the information the map branch needs (everything past 5× centre
  distance clamps to exactly 0.5).
- The label stays sized in **screen px**, not ground metres. This is the arrow doc's option (A)
  — "keep the pixel size, place the quad in the map plane" — and its reasoning transfers
  unchanged: option (B), true ground-metre text, is sub-pixel at low zoom and screen-filling at
  high zoom, and is not what `pitch-alignment` means.

### 3.4 Line labels: walk the label plane, place on screen

The curved branch is where 100 % of the Mapbox impact lives (§1.2) and it needs the space
change of §2(1), not just a basis. The design reuses what is already in the tree rather than
importing MapLibre's architecture (which the world-anchored-placement doc §2 already declined,
for reasons that still hold).

The polyline projection loop (`label-pass.ts:1440-1472`) walks Mercator-metre vertices
`(mxs, mys)`, subdivides by screen gap, and writes three parallel arrays per retained sample:
`_pxScratch` / `_pyScratch` (live screen px) and `_pmScratch` (Mercator arc-length, added by
INC-2 of the world-anchored work). The change:

1. **Project each retained sample a second time with `P₀`** into `_p0xScratch` / `_p0yScratch`,
   sharing sample indices with the live arrays by construction. Gated on the layer resolving to
   `map` AND `pitch > 0`, so an unpitched frame and every `viewport` layer pay nothing.
2. **Run the existing glyph walk on the pitch-0 arrays.** `text-stage.ts:1563-1643` is
   unchanged code operating on a different input: advances, `keepUpright`, the `text-max-angle`
   gate (`:1667-1725`) and `centerOffsetPx` all become label-plane quantities, which is what
   MapLibre's are. This is the whole point — glyph spacing along a foreshortened road is
   currently uniform on SCREEN, which is uniform in the wrong space.
3. **Map each glyph back to the live screen by index correspondence.** The two polylines share
   vertices, so a glyph at label-plane arc-length `s` lands in segment `i` at fraction `t`, and
   its live position is `lerp(live[i], live[i+1], t)`. No inverse, no extra projection. This is
   structurally `mercOffsetToScreenOffset` (`place-labels-along-line.ts:214`), the parallel
   prefix-sum the world-anchored doc §3.2 already built and shipped.
4. **Take each glyph's rotation from the LIVE polyline tangent**, not the label-plane one — the
   glyphs must follow the road as it appears on screen.
5. **Give the quad a pivot.** Add `TextDraw.groundBasisPivot?: [x, y]`, used only when
   `groundBasis` is present, defaulting to the anchor. The point path passes nothing (identical
   behaviour); the curved path passes the label centre. This is why the pivot is a new field and
   not a re-anchoring of `glyphOffsets`: rewriting them as `centre + (abs − centre)` is not
   bit-identical in float, and the absent-basis path must stay bit-identical (§1.3's gate).
6. **One basis per label**, derived at the label's centre — not per glyph. A per-glyph basis is
   6 projections × glyphs × labels, and the basis is a first derivative of a smooth projection,
   so it varies little over a label's span. The residual is a real, bounded approximation for a
   long label crossing a strong pitch gradient; it is the same trade the arrow doc took with a
   single `viewport.z` and it is a NEEDS-PROBE (§9), not an unknown.

### 3.5 Collision: screen-space box, ground-plane footprint

MapLibre's answer (§2(3)) is unambiguous and X-GIS is already aligned with it: the box stays a
screen-space AABB, but it is the AABB of the _projected ground-plane_ footprint, not of the
upright box. `deriveLabelBbox` → `groundBasisAabb` already does exactly this for point labels,
pivoting on the same point the renderer pivots the quad on (`text-stage-helpers.ts:696-706`),
and the reason it must is stated there: a label that lies down while its box stays upright
reserves the wrong footprint and both loses collisions it should win and blocks labels it should
not.

For the curved branch, the box is built from the per-glyph sample extremes plus `halfH`
(`text-stage.ts:1717-1720, 1753-1758`). Once step 3 above places those samples in live screen
space, the box is already in the right place and the only thing missing is the tilt of the
half-height band — which the same `groundBasisAabb`, applied about the label centre, supplies.

**Not in D1:** switching line labels to MapLibre's circle chain. `text-collision.ts` already
carries that capability, landed dormant as INC-3 of the world-anchored work — and INC-4, which
would light it up, was **blocked by measurement**: its witness did not reproduce, and a circle
chain is a strict subset of the box it refines so it can only make X-GIS collide _less_, which
is the opposite of what was wanted. D1 must not resurrect it as a side effect.

### 3.6 Horizon and rim

Ground projection makes the far field worse before it makes it better: a quad flattened toward
the horizon degenerates, and `groundBasisAt` currently answers that with `null` → billboard
(`ground-basis.ts:129-136`, `|det| < 1e-6`). Silently standing one label upright in a field of
lying ones is a worse artifact than dropping it, and MapLibre drops it (§2(4)).

**D1 adopts MapLibre's cutoff**: a label whose unclamped `0.5 + 0.5·wCenter/cw` falls below
`0.6` is dropped. On the globe and the discs the existing culls already cover this
(`horizonCutoff` at `render-loop-helpers.ts:601-603`, the limb polygon at `:623-633`, ortho's
rim margin at `:680`); the flat pitched path has nothing, which is exactly where ground
projection puts the smear. The `null`-basis → billboard fallback stays as the last resort for a
genuinely singular basis.

### 3.7 Depth and draw order — nothing changes, and here is why

Text draws through the RHI Material seam with **no depth-stencil at all**
(`map/src/render/material/text-material.ts:6` — "Premultiplied-alpha blend …, no depth" — and
`:74`, "no depth-stencil"). Ordering is painter's: layer precedence, then a within-layer Y-sort
(`text-stage-types.ts` `layerName`). A ground-projected label is still a screen-px quad written
into the same overlay pass; laying it down changes where its corners are, not what it is
depth-tested against. So the terrain-less globe raises no depth question here — the only
occlusion concern is the horizon, and §3.6 answers it by culling rather than by a depth test.
This also means D1 does **not** unlock label-behind-terrain, and must not be described as if it
did (that is D5's problem).

---

## 4. Socratic self-critique — the questions attacked before proposing

**Q1. Why not reuse the arrow ground-quad path verbatim? It solved this exact problem.**
Because it solved it in the _shader_, for a primitive whose basis can be baked. The arrow bakes
a third geo point per instance (`arrow-pitch-alignment.md` §"Building the map-plane basis") and
takes the difference of two `project_geo` calls in the VS, because "`project_geo` consumes
ECEF/Mercator DSFUN values baked by the packer, so the shader cannot project an arbitrary
offset point it computes itself". Labels have no packer: their anchors are computed on the CPU
every frame from a collision pass whose input is this frame's camera. There is nothing to bake
into, and the text VS receives screen px, not geo. What DOES transfer, and is taken: (i) do not
normalize the basis vectors — their differing lengths under pitch _are_ the foreshortening;
(ii) size in screen px in the map plane, not in ground metres; (iii) the flag-0 / absent-basis
path must be byte-identical, which is why §3.4(5) adds a pivot field instead of re-anchoring
`glyphOffsets`. Rejecting the mechanism while keeping the three lessons is the right split.

**Q2. What breaks for point-placed labels?** Nothing, and that is itself a warning. Point
placement resolves to `viewport` (`label-alignment.ts:40`), so on all 9 audited styles the point
arms A and B (§1.3) are inert even after wiring — which is precisely how a green gate over a
dead feature happens. Two consequences: the point-arm increment must be gated by a _structural_
wiring test (the `label-pass-vt-perspective-wiring.test.ts` pattern), not by pixels; and the
only pixel witness for point labels remains the purpose-built fixture, whose own header explains
why it must be purpose-built. Conversely, wiring A and B is not optional: a style that authors
`text-pitch-alignment: map` on a point layer is exactly the case ADR-0012 §1 requires to reach
`supported`, and today it converts, warns, and renders a billboard.

**Q3. Curved line-following text against flat quads — is one basis per label a lie?** Partly,
and the honest scope of the lie is: the basis is exact at the point it is derived and degrades
outward, so a road name spanning a strong pitch gradient will have its far glyphs placed by
extrapolation. Three things bound it. The glyph POSITIONS do not depend on the basis at all
(they come from the index correspondence of §3.4(3), which is exact at every sample); only the
per-glyph QUAD orientation does, and a quad is ~20 px. The `text-max-angle` gate already drops
labels whose path bends sharply, which correlates with the worst cases. And MapLibre's own
collision box for the same label is an 8-point approximation of the same curved shape, so the
reference is not exact either. It stays a NEEDS-PROBE with a named escalation (per-segment
basis) rather than a hidden assumption.

**Q4. Depth-test vs painter's order against a terrain-less globe?** Settled by reading, not by
inference: there is no depth state (§3.7), so the question does not arise. The trap it conceals
is a different one — believing that "the label lies on the ground" implies "the label is
occluded by the ground". It is not, on either engine. If D1 is described as ground _placement_
rather than ground _occlusion_, no reviewer expects a road name to disappear behind a hill.

**Q5. Perf: per-glyph matrix vs per-label basis vs per-frame anything?** Measured constraints
first. The polyline projection loop was ~80 % of `forEachLineLabelPolyline`'s frame time before
optimisation (`label-pass.ts:1458-1461`), and §3.4(1) doubles it for resolving layers. That is
why it is gated on `resolved === map && pitch > 0` — an unpitched frame and every non-resolving
layer pay literally nothing, which is also what keeps the byte-identity rung reachable. The
basis itself is 6 projections per LABEL (not per glyph, not per sample), matching the point
path's existing cost. `Pitch0Unprojector`'s cache key deliberately excludes pitch
(`pitch0-unproject.ts:19-20`), so a pure tilt — the interaction this feature is for — is a
cache hit on the matrix build.

**Q6. The producer rewrite (§3.1) is not strictly necessary to wire the four dead sites. Why
is it INC-1 instead of a later cleanup?** Because wiring first would ship the far-field error
of §1.4(a) into the exact labels the feature is about, and because the disc projections would
then need a second, per-projection basis path to reach them — the two-authorities drift
`ground-basis.ts:36-40` was written to prevent. Doing it first is also cheaper: it deletes
`probePxFor`'s approximation and the `unprojectToLonLat` scope note rather than working around
them.

**Q7. Does the label-plane walk break the world-anchored phase lattice (#1358 / INC-1 / INC-2)?**
This is the highest-risk interaction and it is a genuine one. `worldPhasePx` is computed by
`mercOffsetToScreenOffset` over the LIVE screen arrays (`label-pass.ts:1484-1489`) and both
branches phase off it (`:1672`, `:1692`). If the curved branch's walk moves to the pitch-0 arrays
while its phase origin stays in live screen px, the two disagree under pitch and the whole
measured cadence work regresses. The fix is mechanical — `mercOffsetToScreenOffset` must be
evaluated against whichever polyline the walk uses — but it must be an explicit, tested step and
not an assumption. It is the first thing a fail-before test for INC-4 should sever.

---

## 5. Increments

Each lands alone, green, with its own gate (ADR-0012 §4.5: one item in flight). `bun run build`

- full vitest + precheck before every commit (CLAUDE.md §11); the pre-merge checklist is built
  from `.github/workflows/test.yml`'s job matrix, not from memory.

Real-GPU tier per ADR-0004 **as amended by CLAUDE.md §5**: WebGL2 and WebGPU both run headlessly
here on SwiftShader, so compile / link / validate / **draw** correctness is on the CI path
(`XGIS_SOFTWARE_GPU=1 HEADED=0`, `?forcegl2=1`, backend asserted in-spec). Hardware-raster
fidelity and timing stay local. Every directional pixel claim uses
`.claude/skills/compare-parity-pixeldiff/compare-diff.py` with DC > 0 and D1 < D0, and every
diff image is read in a 16-split at full resolution.

**INC-1 — the basis producer becomes forward-only and anchored at the label's ground point.**
Rewrite `groundBasisAt` to the §3.1 Jacobian ratio taking `(lon, lat)`; expose the pitch-0
FORWARD matrix from `Pitch0Unprojector`; build a cull-free `P₀` projector; drop `probePxFor`.
_Fail-before:_ a unit test that a label 400 px off-centre at pitch 60 gets a basis derived at its
own ground point — pin the current construction and show it fails; and identity-at-pitch-0 over a
lattice of projType 0–6 × latitude × bearing × zoom, which the current code cannot satisfy for
3/4/5 at all (it returns null). _§5:_ `_label-pitch-alignment-gate` stays green, and pitch-0
frames stay hash-identical (the rung the whole design protects).
_Size:_ ~120 LOC net across 3 files, 1 of them at its ceiling (§6).

**INC-2 — wire the VT point arms (A, B).** `label-pass.ts:1821`, `:1865`.
_Fail-before:_ structural wiring assertions in the `label-pass-vt-perspective-wiring.test.ts`
style; revert one arm and confirm the failure names _that_ arm (CLAUDE.md §12 — cut each half
separately, one cut only proves one message). _§5:_ inert on real styles by construction
(Q2) — assert `labels.groundAligned > 0` on the purpose-built fixture served from a VT source,
not on OFM. _Size:_ ~20 LOC, but `label-pass.ts` has **zero** ceiling headroom.

**INC-3 — wire the straight along-line branch (C).** Extend
`EmitLabelAlongSegmentDeps.addLabel` and `placeInlineLineLabels`'s `addLabel` to carry a basis.
_Fail-before:_ unit — the dep arity carries it and it reaches `PendingLabel`. _§5:_ **no OFM
witness exists** (§1.2 measured zero resolving layers on this branch); the gate is a fixture
authoring `text-rotation-alignment: viewport` + `text-pitch-alignment: map` on a line layer.
Landing this on a "0 px diff, no regression" claim would be exactly the vacuity CLAUDE.md §12
names. _Size:_ ~40 LOC.

**INC-4 — the curved branch: label-plane walk + pivoted basis. The payload.**
Steps 1–6 of §3.4, plus `PendingLineLabel.groundBasis` and `TextDraw.groundBasisPivot`, plus the
Q7 phase-origin alignment. _Fail-before:_ (i) sever the index correspondence (§3.4(3)) and
confirm the failure names the correspondence, not the basis; (ii) sever the phase-origin
alignment (Q7) and confirm the cadence test — not the placement test — goes red; (iii) attach a
basis with the pivot forced to (0,0) and confirm the quad test catches it. _§5:_ OFM Positron,
pitched cameras (the world-anchored doc's z16.7/pitch-60 and z16.0/pitch-45/bearing-30 are the
established pair), settle-until-3-identical-hashes, same-code noise floor measured first;
DC > 0, D1 < D0, and the diff image read in a 16-split. Pitch-0 frames hash-identical.
_Size:_ ~200 LOC across `label-pass.ts` (at ceiling), `text-stage.ts` (2 lines of headroom),
`text-renderer.ts`, `text-stage-types.ts`, `text-renderer-types.ts`.

**INC-5 — pitched size correction.** Replace `text-stage.ts:1024`'s forced 1 with the map-branch
multiplier of §3.3; surface the unclamped distance ratio from the projector.
_Fail-before:_ unit on the formula against MapLibre's clamp bounds (0, 4) — a test that pins the
current forced-1 behaviour must go red. _§5:_ measure a far-field label's pixel height at pitch
60 before and after and against MapLibre (CLAUDE.md §5.3 — measure pixel width, do not eyeball
it). _Size:_ ~40 LOC.

**INC-6 — far-field cutoff.** MapLibre's `perspectiveRatio < 0.6` drop (§3.6).
_Fail-before:_ unit at the boundary; a scene test that a label beyond 5 × centre distance is
dropped and one just inside is kept. _§5:_ count text clusters in the horizon band before/after.
_Size:_ ~30 LOC.

**DEFERRED — globe (projType 7).** §3.2's open decision. Files an issue with the analysis; does
not block D1's exit.

Recommended landing order: INC-1 → INC-4 → INC-5 → INC-6 → INC-2 → INC-3. INC-4 is the only one
that moves a real basemap's pixels; INC-5/6 are the parity tail it exposes; INC-2/3 are
completeness and are the two most likely to be greened vacuously, so they land last, when the
gate authors have already seen what a real one looks like.

**Exit for D1:** the spec-coverage row moves off `partial`, the gap-matrix regenerates, the
`capabilities/symbol.ts` row flips, and `pitchAlignmentGapWarning` is deleted or narrowed to the
globe — a three-way sync the drift gate `spec-coverage-runtime-drift.test.ts` will check.

---

## 6. LOC-ceiling risk

Authority: `map/src/loc-ceiling-ratchet.test.ts` (shrink-only high-water marks; non-baselined
files are capped at `NEW_FILE_CAP = 800`). Measured at `f0e89d8`.

| file                                               | now  | ceiling | headroom | risk                                                                                                                                                                                             |
| -------------------------------------------------- | ---- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `map/src/render/passes/label-pass.ts`              | 1996 | 1996    | **0**    | **Blocking.** INC-2 and INC-4 both touch it. Pay for it by extracting the LINE dispatch to a sibling, mirroring how `dispatch-point-labels.ts` paid for #777 IV3 (ratchet note at `:1039-1045`). |
| `map/src/render-loop-helpers.ts`                   | 841  | 841     | **0**    | **Blocking for INC-1** (the cull-free `P₀` projector variant lives beside `makeLabelProjectors`). Extract the projector factory, or add the variant in `pitch0-unproject.ts` instead.            |
| `compiler/src/ir/lower-label.ts`                   | 1190 | 1190    | **0**    | Zero headroom — but D1 needs no converter change (§1.1). Only a risk if scope creeps.                                                                                                            |
| `map/src/text/text-stage.ts`                       | 2185 | 2187    | 2        | INC-4 adds the pitch-0 walk. Extract the curved-label loop to `text-stage-helpers.ts` (which has 93) — the precedent is the ratchet's own `:939-948` note.                                       |
| `map/src/text/text-renderer.ts`                    | 713  | 800     | 87       | INC-4 adds the pivot. Fits.                                                                                                                                                                      |
| `map/src/text/text-stage-helpers.ts`               | 707  | 800     | 93       | Absorbs the `text-stage.ts` extraction; watch it, it is the escape valve for two files.                                                                                                          |
| `map/src/render/passes/place-labels-along-line.ts` | 517  | 800     | 283      | INC-3. Comfortable.                                                                                                                                                                              |
| `map/src/text/ground-basis.ts`                     | 186  | 800     | 614      | INC-1's main edit. Comfortable.                                                                                                                                                                  |
| `map/src/render/passes/dispatch-point-labels.ts`   | 204  | 800     | 596      | INC-1 signature change. Comfortable.                                                                                                                                                             |
| `map/src/camera/pitch0-unproject.ts`               | 148  | 800     | 652      | INC-1 exposes the forward matrix. Comfortable.                                                                                                                                                   |
| `map/src/text/text-stage-types.ts`                 | 201  | 800     | 599      | `PendingLineLabel.groundBasis`. Comfortable.                                                                                                                                                     |
| `map/src/text/text-renderer-types.ts`              | 87   | 800     | 713      | `TextDraw.groundBasisPivot`. Comfortable.                                                                                                                                                        |

Rule for every one of these: pay a ceiling with an **extraction that has its own reason**, never
with a bump-by-default (ADR-0012 §4.4).

---

## 7. Out of scope

- **The globe (projType 7).** §3.2 — deferred with its reason, not forgotten.
- **`icon-pitch-alignment`.** ADR-0012 D3. The `road_oneway` layers are its witness, not D1's.
- **Circle-chain line collision.** §3.5 — INC-4 of the world-anchored work is blocked by
  measurement and must not ride along.
- **Label occlusion by terrain / the globe surface.** §3.7 — there is no depth state; this is D5.
- **Moving label layout into the tile worker.** Declined once already, for reasons that hold.

Checked and found NOT to be a gap, recorded so it is not re-investigated: zoom-expression
`symbol-placement` (§1.2 note ¹) is split by `parseSymbolPlacementStep`, so the D1 chain sees
the right placement per zoom range.

---

## 8. Rejected alternatives, with reasons

**(R1) Keep the screen-anchor / pitch-0-unproject composition and just wire the dead sites.**
Cheapest by far, and it is what the tree invites. Rejected: it ships §1.4(a)'s far-field error
into precisely the labels the feature exists for, and it leaves 3/4/5 needing a second,
projection-specific basis path — the two-authorities drift `ground-basis.ts:36-40` was written
to prevent.

**(R2) Give the azimuthal discs and the globe an analytic per-projection basis.** Explicitly
forbidden by `ground-basis.ts:33-40` and `pitch0-unproject.ts:22-26`, and the prohibition is
right: a closed-form divisor is correct for one projection and quietly wrong for the rest.
§3.1 reaches the discs without one.

**(R3) Ground-metre text (a true decal).** The arrow doc's option (B): sub-pixel at low zoom,
screen-filling at high zoom, wrong for a symbol field, and not what `pitch-alignment: map`
means in the spec. Rejected there, rejected here, same reason.

**(R4) Per-glyph basis for curved labels.** Correct, and ~6 projections × glyphs × labels per
frame. Rejected for cost; the residual is bounded (Q3) and named as a NEEDS-PROBE with
per-segment basis as the escalation if a measurement demands it.

**(R5) Adopt MapLibre's architecture — bake anchors in the worker, lay out in tile units, port
`updateLineLabels`.** The most faithful option and a rewrite of the label pass, the tile
pipeline and the collision index at once. Declined for the same reason the world-anchored
placement work declined it: the observable behaviour does not require it, and §3.4 gets the same
label plane from two arrays that already exist.

**(R6) Leave `perspScale = 1` under a basis (the current comment's position).** Rejected by
§2(2)'s reading of `symbol_sdf.vertex.glsl:93-101`: the map case is not "no correction", it is
the reciprocal correction. Forcing 1 makes far labels smaller than the reference by the full
perspective factor.

**(R7) Widen `isIdentityBasis`'s epsilon instead of short-circuiting on `pitch`.** Already
rejected in-tree with a measurement (`dispatch-point-labels.ts:82-99`: the f32 round trip is off
by up to 1.995e-6, ~2000× the 1e-9 epsilon). It would be a number chosen to make a test pass and
would swallow a real small tilt. Restated here because it is exactly the kind of thing a later
session re-proposes.

---

## 9. NEEDS-PROBE — open for the implementation phase

1. **`P₀` cull removal.** Which of the three culls (`NDC ±1.5`, horizon, limb inset) must be off
   for the pitch-0 projector, and whether that needs a new parameter on `makeLabelProjectors`
   (ceiling-blocked, §6) or a separate small factory. Probe: log how many far-field anchors get
   `null` from a culled `P₀` at pitch 60, z14.
2. **One basis per label vs per segment, for curved labels.** Measure the screen displacement of
   the last glyph of the longest OFM road name at pitch 60 under a centre-derived basis vs a
   per-glyph one. If it exceeds ~1 px, escalate to per-segment.
3. **Q7's phase origin.** Confirm by construction (not by eye) that moving the curved walk to the
   pitch-0 arrays while `worldPhasePx` is measured against them preserves the measured cadence of
   #1358 / INC-1 / INC-2 across the established zoom sweep.
4. **The unclamped distance ratio.** Where to surface it without a second formula: extend the
   `projectLonLatCopies` tuple (currently `[x, y, perspScale]`, `render-loop-helpers.ts:536`) or
   add a scratch getter beside `perspectiveScale()`. The mercator VT arm uses `projectMerc`,
   which has no tuple — the #1081 wiring note says so.
5. **Interaction with the layout cache.** `text-stage-helpers.ts:679-684` argues the cache stores
   only basis-independent quantities. Re-verify that holds once `sizePx` depends on the map-branch
   multiplier (INC-5) — the cache is keyed on `sizePx`, so it should, but it is a cheap check and
   an expensive miss.
6. **Whether the curved branch's `keepUpright` decision should be made in the label plane or on
   screen.** `text-stage.ts:1604-1621` samples the mid tangent to decide; label-plane and screen
   tangents differ under pitch, and flipping on the wrong one gives upside-down road names at
   high pitch on north-south roads.
7. **The `compare-parity-pixeldiff` / `tile-crop-review` skills are NOT installed in every
   container.** They are absent from `.claude/skills/` on the machine this document was written
   on, while CLAUDE.md §5 requires them and six other plan docs cite
   `.claude/skills/compare-parity-pixeldiff/compare-diff.py`. Confirm they are present before
   starting INC-4, or the §5 gate silently degrades into the downscaled eyeball §5 forbids.
8. **How wide the globe's un-modelled band actually is (§3.2).** Measure the normal-to-view
   cosine at the innermost anchor the limb cull admits, across the zoom range the globe is used
   at. If it stays near 1 the deferral is permanent and should be written into the coverage note
   as a non-issue; if it does not, the globe needs its own reference-frame decision and its own
   issue. Either outcome closes a question rather than leaving it open.
