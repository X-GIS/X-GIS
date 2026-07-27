# Map-aligned arrows — `pitch-alignment: map` for the retained arrow primitive

## Problem

Reported by the user against the live S-111 field: the arrows are billboarded, so under
camera pitch they look wrong — they stay flat-on to the camera instead of lying on the map.
"지도에 붙어야해요." Correctly matched by the user to a Mapbox style property.

Confirmed at the code level. `map/src/shaders/dsl/arrow-retained.ts` builds the quad in
SCREEN PIXELS and offsets the projected anchor in NDC:

```wgsl
offNdc = (rx * 2/vp.x, -ry * 2/vp.y)
clip   = centerClip + offNdc * centerClip.w      // always faces the camera
```

Worse, the direction is normalised first — `cc = dsx/dlen; ss = dsy/dlen` — which
**discards the foreshortening** the projection had already computed. So even the
orientation carries no pitch information.

## The matching standard property

Mapbox/MapLibre `icon-pitch-alignment: map` (paired with `icon-rotation-alignment: map`).
Note this engine already declares the typings but has **not implemented them**:

```ts
// compiler/src/ir/render-node.ts:566
// ── Deferred (placeholder typings; semantics defined later) ──
rotationAlignment?: 'map' | 'viewport' | 'auto'
pitchAlignment?: 'map' | 'viewport' | 'auto'
```

They are threaded for labels only (`compiler/src/ir/lower-label.ts:1084`) and consumed by no
shader. The arrow would be the FIRST real implementation, so this doc also sets the pattern
a later icon/text implementation should follow.

## Design

### Sizing decision: pixel size, map plane (option A)

Two readings of "stick to the map":

- **(A) Keep the pixel size, place the quad in the map plane.** At pitch 0 it renders
  exactly as today; under pitch it foreshortens. Zoom does not change the on-screen size.
  This is what Mapbox's `pitch-alignment: map` actually does, and it matches the S-111
  catalogue, which sizes symbols in **millimetres at chart scale** — a paper/screen size,
  not a ground size.
- **(B) True ground-metre size** (decal). Arrows grow when zoomed in, shrink when zoomed
  out — sub-pixel at low zoom, screen-filling at high zoom. Wrong for a symbol field.

**Chosen: (A).**

### The scale seam already exists

`pointU.viewport.z` is **metres per pixel** (`map/src/shaders/dsl/point.ts:99`), already
used to convert real-world units to pixels for circle radii (`point.ts:333-336`). That is
the pitch-independent reference scale needed to turn a pixel size into a ground length.

### Building the map-plane basis

`project_geo` consumes ECEF/Mercator DSFUN values **baked by the packer**, so the shader
cannot project an arbitrary offset point it computes itself. The basis must therefore come
from baked geo points, exactly like the existing tip.

Bake a THIRD point: the anchor stepped `TIP_STEP_DEG` **perpendicular** to the bearing.
Then in the VS, with all three projected:

```
alongNdcPerStep = ndcTip  - ndcTail      // one TIP_STEP_DEG along the bearing
sideNdcPerStep  = ndcSide - ndcTail      // one TIP_STEP_DEG across it
k               = (size * viewport.z / 111320) / TIP_STEP_DEG
offsetNdc       = qx * k * alongNdcPerStep + qy * k * sideNdcPerStep
```

This is the projection's Jacobian at the anchor. Foreshortening, map-bearing rotation and
globe curvature all fall out of the same `project_geo` ladder that already runs — no new
projection math, and it is correct on every projection the engine supports.

Do **not** normalise the basis vectors: their differing lengths under pitch _are_ the
foreshortening.

### Cost

- Feat stride 29 → 41 (the 12-slot ECEF/lon-lat/Mercator DSFUN block) + 1 alignment flag = 42.
- ~8 MB → ~11.6 MB for a 69k-arrow CBOFS field. Opt-in, so only S-111 pays it.
- One extra `project_geo` call in the VS (heavily CSE'd — it does not depend on
  `vertex_index`).

### Known approximation (must be documented in the code)

`viewport.z` is a single metres-per-pixel value for the camera centre. Under pitch the true
scale varies across the screen (near vs far). Using one value is exact at the centre and
degrades toward the edges. Mapbox's `circle-pitch-scale` makes the same trade. Acceptable;
state it in the shader comment rather than letting a reader assume exactness.

### Opt-in and zero regression

Gate on a per-instance flag (`map_aligned`, 0 = viewport/billboard). Flag 0 must take the
existing screen-px path **unchanged**, so every current `| arrow` consumer is byte-identical
— the same discipline `stroke_units` and `drift_px` already follow in this shader.

## Ordering constraint

This changes the vertex offset path, which the glyph **drift** (#1333, landed on
`claude/arrow-glyph-drift`) also writes to. Drift currently offsets in screen px:

```ts
driftNdc = ((driftPx * cc * 2) / vp.x, (-driftPx * ss * 2) / vp.y)
```

Under map alignment that offset must use the same `alongNdcPerStep` basis, or the glyph will
lie flat while its motion slides along the screen plane. **Do pitch-alignment before, or
together with, the drift wiring** — otherwise the drift offset gets written twice.

## Verification plan

- Emission gates (mirroring the drift gates in `arrow-retained-dsl.test.ts`): the third geo
  block is read; both basis deltas reach the position; the flag-0 branch still emits the
  original screen-px expression.
- Fail-before: neuter the side basis and confirm the position gate fails — a varying-exists
  assertion would not catch it (this session already produced two vacuous assertions that
  had to be tightened; do not repeat that).
- Packer: byte-parity with the host path must still hold at flag 0.
- Real-GPU (⏳, no GPU in the remote environment): pitch sweep 0°/30°/60° — arrows must lie
  in the ground plane and foreshorten, with the pitch-0 frame matching the pre-change render.
