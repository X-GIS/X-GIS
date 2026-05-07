# Roadmap — 3D Polygon Extrusion + Text Rendering

User-requested capabilities for "more complex scenes". Each is multi-
session engineering work. This doc lays out the scope so subsequent
sessions land focused, scoped contributions.

## Current state (commit 64b847c)

3D extrusion MVP — Phase 1 only:
- WGSL Uniforms has `extrude_height_m: f32`
- `vs_main_quantized` lifts polygon vertex to world-z = extrude_height_m
- Hardcoded 50 m for `buildings` MVT slice in vector-tile-renderer
- Visible at tilted camera (pitch ≥ 45°): polygon "roofs" lift off ground

**Remaining for usable 3D**:
- side walls (vertical quads connecting bottom-z=0 to top-z=height)
- per-feature heights (each building uses its own `feature.height`)
- lighting / shading (face-normal Lambert)

**Text rendering**:
- nothing yet — no glyph atlas, no symbol layer, no collision, no labels

## 3D Extrusion — Phase 2: Side walls

Without side walls, the lifted polygon is a "floating roof" — visible
only as the top face. Real buildings need vertical walls connecting
roof to ground.

### Approach: compile-time wall mesh generation

Compiler change (`vector-tiler.ts`):
1. After polygon tessellation, walk each ring's vertex pairs `(a, b)`.
2. Emit four corner vertices per wall: `a_bot`, `a_top`, `b_bot`,
   `b_top`. Top vertices marked `is_top=1`, bottom `is_top=0`.
3. Two triangles per wall: `(a_bot, b_bot, a_top)` and `(b_bot, b_top,
   a_top)` (winding order outward-facing).
4. Append wall vertices to the existing polygon vertex buffer; wall
   indices to the existing index buffer.

Vertex format change:
- Current: `unorm16x2` (mx, my) + `float32` (feat_id) = 8 bytes
- Need: + 1 bit (is_top). Could pack into the high bit of mx or my
  (sacrifices 1 unit of position precision = irrelevant), OR add a
  second `unorm16x2` slot for (z, _spare_) = +4 bytes (12 byte stride)

Recommended: pack `is_top` into mx's high bit. 0 / 65535 → top, 1 /
65534 → bottom. Compiler quantizes accordingly. Shader: `is_top =
(pos_norm.x > 0.5 - 0.5/65535) ? 1.0 : 0.0`. No format change.

Shader change (`vs_main_quantized`):
```wgsl
let z_world = is_top * u.extrude_height_m;
let clip = u.mvp * vec4<f32>(rtc, z_world, 1.0);
```

### Approach: runtime wall mesh generation

Alternative — VTR generates walls at upload time. Avoids compiler
change but adds per-tile CPU cost. Not recommended (compile-once is
cheaper than upload-many).

### Effort

- Compiler: ~150 LOC + tests
- Format: ~50 LOC (pack is_top + WGSL decode)
- Lighting (optional): ~30 LOC (face normal + dot)
- Total: 1-2 commits, 1 day

## 3D Extrusion — Phase 3: Per-feature heights

Different buildings have different heights. protomaps v4 buildings
layer carries `height` (or `building:height`) feature property.

### Approach: PropertyTable + storage buffer

Existing infrastructure:
- compiler `PropertyTable` collects per-feature properties
- runtime `buildFeatureDataBuffer` uploads to GPU storage buffer
- shader variant reads field by `feat_id` via the bind group

Steps:
1. Style: `extrude: .height` syntax (or `extrude: 50` for constant).
2. Compiler: when style declares `extrude:`, ensure `height` field
   is in the PropertyTable for the layer.
3. Shader variant generator: when `extrude` is present, emit a
   storage-buffer read of `height` keyed on `feat_id`. Use that value
   as the world-z multiplier instead of the constant uniform.
4. Style `match()` for `extrude:` works the same as for `fill:` /
   `stroke:` — categorical heights by feature kind.

Effort: 1-2 commits, 1-2 days.

## Text Rendering — Phase 1: SDF font atlas

Industry standard (Mapbox, MapLibre, deck.gl): SDF (signed distance
field) bitmap atlas. One bitmap encodes glyph shapes; shader samples
distance + uses smoothstep for clean edges at any scale + rotation.

### Approach: pre-baked atlas

For MVP — pre-bake one font (e.g., Inter Regular) at 256×256 atlas
covering ASCII + Latin-1 supplement. Tools:
- `msdfgen` (C++ / WASM)
- `fontnik` (Mapbox's, Python)
- bundled as static asset in playground

Layout:
- 32px grid → 8×8 = 64 glyphs (ASCII printable)
- Per-glyph: u16 atlas (u, v, w, h) + glyph metrics (advance, bearing)
- Shipped as `.png` + `.json` metadata

### Effort

- Atlas generation: borrow existing tool's output, ~1 hour
- Loader / parser: ~50 LOC
- Total: <1 day for MVP atlas

## Text Rendering — Phase 2: Glyph quad pipeline

Each glyph drawn as one quad with SDF texture sample. Many quads
batched per draw call.

### Approach: Instanced quads

- Vertex buffer per layer: one entry per glyph instance, stride
  ~24 bytes — `(world_xy_anchor: vec2<f32>, char_code: u16,
  glyph_offset_xy: vec2<f32>)`
- Shader expands instance to 4 quad vertices (top-left, top-right,
  bot-right, bot-left) using gl_VertexID
- Sample SDF atlas, alpha = smoothstep(threshold, threshold+aa,
  distance)
- Halo: second smoothstep at threshold-halo_radius, output as halo
  alpha for outline

### Effort

- Pipeline + shader: ~200 LOC
- Vertex buffer builder: ~100 LOC (CPU side, per-feature glyph
  expansion)
- Total: 1-2 days

## Text Rendering — Phase 3: Layout engine

Take a string + font metrics, produce glyph positions.

### MVP

- ASCII only, left-to-right, no kerning
- Single line (no wrap)
- Anchor: center of feature bbox (point) or middle of line geometry

### Future

- Bidi (RTL: Arabic, Hebrew)
- CJK (per-glyph width, no kerning)
- Multiline + wrap
- Along-line text (each char rotated to follow road geometry)

### Effort (MVP)

- Layout function: ~80 LOC
- 1 day

## Text Rendering — Phase 4: Symbol layer

A new layer kind (`symbol` next to `fill` / `stroke`) — per-feature
text + icon placement.

### Style syntax

```
layer place_labels {
  source: pm_world
  sourceLayer: "places"
  text: .name
  text-size: 14
  text-color: slate-900
  text-halo-color: white
  text-halo-width: 1.5
}
```

### Compiler / runtime

- Parser: new `text:`, `text-size:`, `text-color:`, `text-halo-*`
  keywords
- Runtime: add `SymbolRenderer` alongside fill/line renderers
- Bucket scheduler: symbol bucket renders LAST (over everything)

### Effort

- Style parser + IR: ~100 LOC
- SymbolRenderer + per-show plumbing: ~150 LOC
- 2 days

## Text Rendering — Phase 5: Collision detection

Without collision, labels overlap unreadably at low zoom. Mapbox
uses a greedy bbox-based algorithm: process labels by priority, skip
if bbox intersects an already-placed label's bbox.

### MVP — greedy

1. For each visible feature with text, compute label bbox in screen
   space at the camera's zoom.
2. Sort by priority (e.g., feature `pop` for places, road class for
   roads).
3. For each in priority order: if bbox doesn't intersect any
   already-placed bbox in the working set, place it; else skip.
4. Hide skipped labels.

### Future

- Continuous priority across pan / zoom (avoid label flicker)
- Spatial index (RTree) for large counts
- Cross-tile coordination

### Effort (MVP)

- Greedy collision: ~100 LOC + tests
- 1 day

## Estimated total

| Feature                       | Time |
|-------------------------------|-----:|
| 3D side walls                 | 1 d  |
| 3D per-feature heights        | 1-2 d|
| 3D lighting (optional)        | 0.5 d|
| Text — SDF atlas              | 0.5 d|
| Text — glyph pipeline         | 1-2 d|
| Text — layout engine          | 1 d  |
| Text — symbol layer integration | 2 d|
| Text — greedy collision       | 1 d  |

Cumulative: 3D ≈ 3-3.5 days. Text ≈ 6-7 days.

## Order of implementation

Recommended:

1. 3D side walls (1 d) — biggest visual impact for least work
2. Text SDF atlas + glyph pipeline + layout (3 d) — minimum viable
   text rendering
3. Text symbol layer + greedy collision (3 d) — production-grade text
4. 3D per-feature heights (2 d) — polish
5. 3D lighting (0.5 d) — final visual polish
