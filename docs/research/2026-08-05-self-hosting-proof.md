# Self-hosting proof — what porting a symbolizer to `.xgis` actually showed

_docs/research/2026-08-05-self-hosting-proof.md_
_Written while closing #1540, the acceptance test of the language-v3 programmability epic (#1541). Grounded in the repo at `main` after #1591 merged._

---

## 0. The claim, and what was actually proved

#1540's success criterion:

> **A new symbolizer can be added by writing `.xgis` only — zero library TS edits.**

**That is proved.** `playground/public/stdlib/shapes.xgis` declares two point symbolizers,
is fetched over HTTP by the ordinary import resolver, and renders:

|                                       | pixel hash | non-background px |
| ------------------------------------- | ---------- | ----------------- |
| `shapes.star5` (authored in `.xgis`)  | `27l1z`    | 8102              |
| built-in `shape-star`                 | `27l1z`    | 8102              |
| `shapes.star7` (**no** built-in twin) | `gzwf7c`   | 10833             |

Gate: `playground/e2e/_stdlib-shape-parity.spec.ts`, headless WebGL2, backend pinned and
asserted, `adaptive=0`. Reproduce:

```
cd playground && XGIS_SOFTWARE_GPU=1 HEADED=0 \
  XGIS_CHROMIUM_EXECUTABLE=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell | head -1) \
  ./node_modules/.bin/playwright test e2e/_stdlib-shape-parity.spec.ts
```

The star7 row is not decoration. Hash equality alone would also pass in a world where the
shape name is ignored and every fixture draws one default glyph — the "assertion that fails
either way" trap. star7 hashing _differently_ is what makes the parity row mean "the same
shape" instead of "shapes don't matter here."

## 1. The premise the issue was written on is wrong, in a way worth keeping

#1540 says: pick one built-in symbolizer, port its **"self-contained fragment math"**.

**There is no per-symbolizer fragment math to port.** A shape in this engine is _path data_:

- `map/src/text/sdf-shape.ts:333` — `BUILTIN_SHAPES.star = starPath(5, 1.0, 0.38)`, an SVG
  path string. Same for square, diamond, triangle, cross, hexagon, pentagon.
- `map/src/shaders/dsl/point.ts:251` — `sdf_shape(uv, shape_id)` is **one shared bezier path
  rasterizer**. It reads a shape descriptor and its segments out of storage buffers
  (`shapesB` / `segmentsB`) and evaluates distance + winding. It has no per-shape branch.

So the star and the hexagon differ by _bytes in a storage buffer_, never by shader code. The
compile-side test (`compiler/src/__tests__/stdlib-self-hosting.test.ts`) pins this directly:
the `.xgis`-authored fixture and the built-in fixture resolve to the **same shader variant
key**, agree on every paint value, and differ only in which shape name they carry.

That reframes the result honestly: this is self-hosting of the **geometry** family. It is
real — a user adds a symbolizer with zero TS — but it is not self-hosting of _rendering
computation_.

## 2. `symbol` already did most of this, since Major 1

`symbol X { path "…" }` (spec §2.8) has always lowered to `SceneCommands.symbols`, which
`map/src/scene-renderers.ts:74` feeds to `ShapeRegistry.addUserShape` under a `user:`
namespace where it shadows a built-in of the same name. So the epic's acceptance criterion
was partly satisfied before the epic began.

What #1540 adds on top is the **module** story: the symbolizer now lives in an importable,
independently-served `.xgis` file with a parameterized `preset` as its public surface, and
its equivalence to the built-in is _proved by pixels_ rather than assumed.

Naming detail that matters for anyone extending this: the stdlib symbol is `star5`, **not**
`star`. A user symbol shadows the built-in of the same name, so reusing the name would have
made the parity test compare the module against itself — green, and meaningless.

## 3. What is still NOT self-hosted (the real remaining distance)

DESIGN.md §5.0 asks for "every rendering primitive implemented in the X-GIS language itself."
The gap between that and today is **not** more shapes. It is that there is nowhere to put
rendering _math_ for most geometry:

- The `@color` / `@stroke` stage blocks (#1538) lower into
  `ShaderVariant.fillExpr` / `strokeExpr`.
- Those slots are consumed **only** by `map/src/render/polygon-shader-cache.ts` and
  `map/src/render/pipeline-factory.ts` — the polygon path.
- The point and line renderers never read `variant.fillExpr` at all.

So a `.xgis` author can write fragment math for a polygon fill or stroke, and nowhere else.
There is also no vertex-side seam anywhere (`PolygonVariantSpec` carries only the two
fragment expressions; noted during #1538's survey).

And on the one surface that does have a seam, a **data-driven** stage body is WebGPU-only:
`ensureFillMaterialRhi()` (`map/src/render/vector-tile-renderer.ts:702`) always compiles the
`null` variant, and `renderer.ts:471` skips variant pipeline construction on WebGL2.

Filed as a follow-up issue; that is the honest measure of remaining distance to §5.0.

## 4. What the port surfaced about the language

Four rough edges, in the order they were hit. Each is a candidate for the next wave.

### 4.1 A namespaced preset cannot be _called_ from the importing module — silently

The issue's own example does not work:

```xgis
import * as shapes from "/stdlib/shapes.xgis"
layer cities { source: cities  style: shapes.star(#fbbf24, 14) }
```

`shapes.star(#fbbf24, 14)` parses as `FnCall{ callee: FieldAccess{ shapes, star } }`, but
`compiler/src/ir/lower.ts:378-386` only recognises `style: <Identifier>` and
`style: <Identifier>(…)`. The FieldAccess forms fall through **with no diagnostic**: the
layer simply gets no preset and renders nothing.

`compiler/src/module/resolver.ts:474-493` does rewrite `style:` references — but only
_intra-module_ ones (a layer inside the imported file naming its own preset). The consumer
side was never covered. #1071 (namespaced import) and #1536 (parameterized presets) each
shipped their half; the intersection was never exercised until this milestone tried to use
it exactly as documented.

The fixtures here use the plain splice import (`import "/stdlib/shapes.xgis"`), which lands
definitions globally and works today. The silent-failure aspect is the worse half of this
bug: an unresolvable `style:` reference should be a diagnostic, not a blank layer.

### 4.2 `symbol` is not parameterizable

`symbol` accepts literal path strings only. A 5-point and a 7-point star cannot come from one
definition with a point-count argument — they are two hand-written coordinate lists. The
built-in side generates them from `starPath(points, outerR, innerR)`; the language has no
equivalent, so a `.xgis` stdlib duplicates coordinates that a TS helper computes. This is the
sharpest ergonomic gap the port exposed, and the one most likely to matter for a real stdlib.

### 4.3 `preset` is namespaced; `symbol` and `fn` are global

Under a namespaced splice, presets are renamed to `ns.name` while symbols, fns and structs
stay global (`compiler/src/module/resolver.ts:552-566`, and the comments there explain why:
a qualified name is not a legal callee/`schema:` identifier). Defensible per-construct, but as
a whole it means a module's surface is split across two namespacing rules, and an author has
to know which is which.

### 4.4 A stage block must precede utility lines

`layer l { | opacity-[x]  @color { … } }` is a parse error ("Expected utility name, got At");
the stage block has to come first. Discovered while writing a #1539 fixture, re-hit here.
Harmless once known, invisible until hit.

## 5. Bottom line

- The epic's acceptance criterion holds for the shape family, proved by pixels, with zero
  library TS edits.
- The framing "port the fragment math" does not survive contact with the code — shapes are
  data, and one rasterizer serves them all.
- The remaining distance to DESIGN.md §5.0 is a **missing seam**, not missing stdlib content:
  `.xgis` can express rendering computation for polygon fill/stroke only, and only on WebGPU
  when it reads per-feature data.
