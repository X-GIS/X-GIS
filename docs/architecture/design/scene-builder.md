# SceneBuilder — an imperative JS front-end to the .xgis compiler (#1194)

Status: **A0 approved → A1a landed** (builder core + parity gate, this PR).
A1b (`runScene` seam) next.
Author-architect discipline: this doc proposes the boundaries and then attacks
them (§Socratic critique) before any increment lands.

## 1. Problem

Scene construction is DSL-only: the only entry points that create sources /
layers are `run(source)` (`map/src/map.ts:2281`), `runBinary` (`:3616`),
`load` (`:3775`). The MapLibre-parity imperative methods are deliberate
warn-once stubs (`map.ts:1329-1369`) — "X-GIS uses compile-time IR, not
runtime style mutation." Consequences (issue #1194): the gallery's ~140 .xgis
examples have zero JS twins (a JS version cannot be written), MapLibre-style
hosts have no ramp, and dynamic hosts must codegen .xgis strings.

The stubs' rationale is load-bearing and this design **keeps it**: one
compile pipeline (`parse → lower → optimize → emitCommands`) remains the
single authority for scene semantics.

## 2. Proposal

A typed **`SceneBuilder`** that constructs the **same `Program` AST the
parser produces** (`compiler/src/parser/ast.ts` — plain, acyclic, JSON
data), and a **`map.runScene(scene)`** entry that feeds it to the same
post-parse pipeline `run()` uses.

```ts
import { SceneBuilder, field, interpolateZoom } from '@xgis/compiler'

const scene = new SceneBuilder()
  .source('terrain', {
    type: 'raster-dem',
    url: 'https://…/{z}/{x}/{y}.png',
    encoding: 'terrarium',
  })
  .layer('relief', (l) => l.source('terrain').util('hillshade-exaggeration-0.6'))
  .layer('cities', (l) =>
    l.source('places').util('fill', interpolateZoom([8, '#e8e0d8'], [16, '#c96f4a'])),
  )
  .build() // → SceneProgram (branded Program AST)

await map.runScene(scene) // same lower → optimize → emitCommands → mount as run()
```

### 2.1 Boundaries & dependency direction

- **`compiler/src/builder/`** — the builder lives IN the compiler package,
  next to the AST it constructs. No new package (§Socratic C3). It imports
  ONLY `../parser/ast` types — a leaf dependency; zero imports from lower /
  codegen / convert.
- **`map`** gains `runScene(scene: SceneProgram)`: `run()`'s inline parse
  (`map.ts:2297-2300`) is extracted so both entries share one post-parse
  body (`_runProgram(ast, baseUrl)`). map → compiler is an existing edge; no
  new package edge, engine untouched, no arch-ratchet change.
- **Public contract = the builder, NOT the AST.** `build()` returns
  `SceneProgram`, a branded opaque wrapper; `runScene` accepts only it. The
  raw AST stays semver-internal (§Socratic C5).

### 2.2 Single authority per concept

| Concept                                                             | Authority (unchanged)                                                                 | Builder's relation                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Utility semantics (`fill-red-500`, `hillshade-exaggeration-0.6`, …) | lowering's binding-handler registry (`lower-bindings*.ts`), matching **name strings** | builder emits the same name strings via `.util(name, binding?)`  |
| Expression semantics (`interpolate`, `match`, `gradient`, filters)  | lower/codegen over `Expr` trees                                                       | typed helpers construct the same `Expr` shapes the parser yields |
| Scene → commands                                                    | `lower → optimize → emitCommands`                                                     | untouched; builder output enters at the parse seam               |
| Scene mount / swap                                                  | `run()`'s post-parse body                                                             | extracted, shared verbatim by `runScene`                         |

The builder adds **no second semantics anywhere** — it is a constructor of
the parser's output format.

### 2.3 The typed surface (and its honest limit)

The core is **untyped at the utility level**: `.util(name: string,
binding?: Expr)`. Typed sugar (`.fill(c)`, `.strokeWidth(n)`,
`.hillshadeExaggeration(x)` …) is a thin veneer that emits those strings.

**Correction to #1194's sketch:** deriving the typed surface from the
binding registry is NOT possible — the handlers are closures
(`match: (c) => c.name.startsWith('hillshade-exaggeration-')`,
`lower-bindings-hillshade.ts:44-112`), not declarative data. Building a
parallel declarative table to derive types from would be the exact
two-authorities trap #1189 just taught us. Instead:

- **Drift guard = the paired-example parity corpus** (§2.4): a sugar method
  that emits a wrong name fails its example's AST-equality gate.
- Sugar is added **only alongside a paired example that exercises it** —
  coverage grows with proof, never ahead of it.

### 2.4 Verified-by-construction gate

For every paired example `X` (an `.xgis` text + its builder program):

```
structuralEqual( builder(X).build().program , parse(xgisText(X)) )   // CI, no GPU
```

Structural equality is the `irEqual` idiom (shader-dsl `optimize.ts:75`) —
defined-key comparison, order-insensitive. Where incidental AST fields
legitimately differ (`line` numbers — the builder has no source lines), the
comparator masks exactly that field, and ONLY that field, by construction
(`{ ...node, line: 0 }` normalisation on both sides). A second gate runs the
pair through `lower()` and compares emitted `SceneCommands` for byte
equality — catching any masked-field mistake from the other side.

## 3. Increments (author pass, one PR each)

- **A1a — builder core (compiler-only).** `compiler/src/builder/scene-builder.ts`:
  `SceneBuilder` (source/layer/background + `.util` + `BlockProperty`
  values), `SceneProgram` brand, expression helpers (`field`,
  `interpolateZoom`, `matchOn`, `gradientOn`), and the parity gate over 3
  seed pairs (`minimal`, `zoom`, `continent-match`). No map change. Gate:
  `bun run build` + new vitest + fixture-sweep untouched.
- **A1b — `runScene` seam (map).** Extract `run()`'s post-parse body into
  `_runProgram`; `runScene(scene)` = brand-check + delegate. **Risk:
  `map.ts` sits at a LOC-ratchet ceiling** — the extraction must be net-≤0
  in that file (the two new method headers offset by the removed inline
  block) or ship with an offsetting extraction; measured with `git show |
wc -l` per §12, not eyeballed. Gate: build + map suite + a SwiftShader
  render probe of a `runScene` demo (offline geojson) proving the mounted
  scene renders identically to its `run()` twin (pixel-diff, §5).
- **A2 — expression parity growth.** Filters, `case`/conditional, presets /
  keyframes / symbols — each with its paired example.
- **A3 — gallery JS tabs (#1192).** Each demo gains a builder twin; the
  gallery shows both, pinned by the corpus gate.
- **B — incremental add/remove** as builder-diff + scene re-run (`run()`
  already supports live swap). Explicitly out of A-scope.

## 4. Socratic critique — attacked before approval

- **C1. "Just implement MapLibre's mutable style object."** REJECTED. It
  forks scene semantics into a second, runtime authority; every byte gate
  (goldens, variant-diff, coverage drift) sits downstream of the compile
  pipeline and would guard only half the truth. The builder keeps one
  pipeline; imperative _mutation_ arrives later as builder-diff + re-run
  (Phase B), still through the same pipeline.
- **C2. "Derive the typed surface from the binding registry."** REJECTED —
  see §2.3. The registry is closures; a parallel table = two authorities
  (#1189's exact failure class). The corpus gate is the drift guard, and
  sugar grows only with paired proof.
- **C3. "New package `@xgis/scene-builder`."** REJECTED at this scale:
  no boundary is protected by it (builder depends only on AST types), and it
  adds a publish/exports/dual-instance surface for nothing —
  right-sized-not-gold-plated. Revisit only if the builder grows consumers
  outside map.
- **C4. "Skip the AST; build `SceneCommands` directly."** REJECTED. It
  bypasses `lower()`'s validation, warnings, merge passes and `optimize()` —
  a second lowering semantics by construction, and `.xgb`-shaped coupling to
  an internal format.
- **C5. "Expose `Program` and let hosts hand-craft it."** REJECTED as the
  contract (kept as the mechanism): raw AST as public API freezes an
  internal format. The `SceneProgram` brand keeps the AST swappable while
  the builder surface stays stable.
- **C6. Where does it still couple?** `runScene` makes map depend on the
  brand — one type import over an existing edge. The builder must uphold
  invariants the parser normally guarantees (utility-name shapes, match-arm
  desugaring like comma-pattern splitting, keyframe sorting). These are
  enumerated as builder unit tests in A1a; any parser-guarantee we cannot
  cheaply uphold in the builder is grounds to shrink A1 scope, not to relax
  `lower()`.
- **C7. What leaks content into a generic layer?** Nothing: engine and RHI
  are untouched; everything lands in compiler (content layer by charter)
  and map's existing scene-mount path.

## 5. Open questions (answer before A1b, not blockers for A1a)

- `import` statements: builder omits them (hosts compose in JS). Does any
  lower() path REQUIRE resolved imports pre-lower? (run() resolves imports
  post-parse — the extraction point must sit after resolution or accept a
  no-imports invariant for `SceneProgram`; verify in A1b.)
- `Demo`-gallery JS-tab plumbing (A3): where the builder source text for
  display lives (paired file? inline template?) — decide with #1192's
  gallery work, not here.
