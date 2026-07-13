# XGIS style language vs peers — a 1:1 quantitative comparison

_docs/research/2026-07-13-xgis-language-vs-peers.md_
_Author: language-design analysis session, 2026-07-13. Read-only audit of the `.xgis` language as implemented in `compiler/src/` at HEAD._

---

## 0. Method, corpus, and spec-version assumptions

**Live counts** (everything about XGIS) were measured directly from this repo on 2026-07-13:

- Syntax corpus: all **136** `playground/src/examples/*.xgis` files (12 read closely: minimal, openfreemap-bright, dark, categorical, filter-gdp, animation-showcase, multiline-labels, custom-shapes, import-maplibre-demo, step-and-concat, along-path-roads, osm-style, income-match, inline-data, zoom-lod, heatmap, procedural-circles, gradient-points).
- Grammar/semantics: `compiler/src/{lexer,parser,eval,ir,module,schema}` (the **real** parser — note `blueprint/` is _not_ the parser; it is a node-graph visual editor that code-generates `.xgis` text and derives its node catalogue from `compiler/src/schema/language.ts`).
- Interop: `compiler/src/convert/*` + the `spec-coverage/` census (re-counted live).
- Ergonomics: the repo's own converter was executed (`bun`) against `compiler/src/__tests__/fixtures/openfreemap-bright.json` to obtain measured char/line/token ratios.

**Training-knowledge counts** (explicitly marked ⚠ below) cover the peers:

- **Mapbox GL Style Spec v8** as implemented by Mapbox GL JS v3.x (knowledge to Jan 2026). My enumeration of its documented expression reference lands at **≈101 operators** (15 type ops + 6 feature-data + 9 lookup + 13 decision + 4 ramps + 2 binding + 5 string + 5 color + 26 math + 3 camera + 1 heatmap + v3-era additions `config`, `measure-light`, `random`, `raster-value`, `distance-from-center`…). The often-quoted "~130" counts synonyms, curve forms and overloads.
- **MapLibre Style Spec v4/v5**: same shape minus Mapbox-proprietary ops (`config`, `measure-light`, `model`, `raster-particle`), plus `global-state` (v5) → **≈85 operators**; adds `globe` projection, keeps `terrain`/`sky`.
- **CartoCSS 2.x/3.x** (carto→Mapnik, TileMill/Kosmtik lineage; effectively frozen since ~2016).
- **OpenLayers flat style** (ol ≥7 expression system; **≈40 operators** in `ol/expr` ⚠).

Scores are 1–5 per dimension; every claim that can carry a number does.

---

## 1. What the language is (snapshot)

XGIS is a **line-oriented block DSL with Tailwind-style utility pipes**:

```xgis
source world { type: geojson, url: "ne_110m_countries.geojson" }

layer countries {
  source: world
  filter: .GDP_MD_EST > 1000000
  | fill-stone-200 stroke-stone-400 stroke-1 opacity-90
  | size-[sqrt(.pop_max) / 80]
}
```

Measured surface:

| Axis                  | Count                                                                                                                                                                                | Source                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Statement kinds       | 14 (`let show fn expr source layer background preset import symbol style keyframes` + fn-body `if/return/for`)                                                                       | `parser/ast.ts:8-23`                            |
| Expression node kinds | 14 (literals incl. unit-suffixed numbers, color, array, object; field access `.f`; call; binary; unary; ternary; pipe; match-block; index)                                           | `parser/ast.ts:104-119`                         |
| Reserved keywords     | 27 tokenized (incl. **8 vestigial**: `place view on struct enum simulate analyze export` — reserved, unimplemented)                                                                  | `lexer/tokens.ts:90-119`                        |
| Unit tokens           | 7: `px m km nm deg s ms` (+`size-[expr]km` binding units)                                                                                                                            | `lexer/tokens.ts:121-129`                       |
| Utility-name families | **78** hyphen-prefixes in the lowering code (paint, label, animation, raster, heatmap, extrusion…) + ~10 bare utilities (`visible hidden flat billboard heatmap label-along-path …`) | grep over `ir/lower*.ts`                        |
| Named colors          | 22 Tailwind families × 11 shades = **242** + `transparent` etc.                                                                                                                      | `site/docs/utilities.astro`, `tokens/colors.ts` |
| Paint property model  | `PropertyShape<T>` with 5 evaluation classes: constant / zoom-interpolated / time-interpolated / **zoom-time** / data-driven                                                         | `ir/property-types.ts:46-87`                    |
| Reserved eval keys    | 5: `$zoom $pitch $featureId $geometryType $geometry`                                                                                                                                 | `eval/reserved-keys.ts`                         |

**Construct usage census over all 136 examples** (files containing each): `source`/`layer` 130 · `keyframes` 10 · `filter:` 9 · `match(` 8 · `interpolate(zoom` 7 · `label-*` 7 · `symbol` 6 · `import` 6 · `categorical(` 4 · `background` 3 · `style` 2 · **`preset` 0 · `fn` 0 · `let` 0 · `show` 0**. Four constructs have _zero_ corpus usage — see deficiency L9.

---

## 2. D1 — Expression power

### 2.1 Operator inventory (counted)

**XGIS runtime evaluator** (`eval/evaluator.ts` + `eval/evaluator-helpers.ts`):

| Class                    | Ops                                   | Names                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builtin functions        | **51** canonical (+6 alias spellings) | clamp min max round floor ceil abs sqrt log10 log2 scale step concat downcase upcase typeof slice index_of number_format pi e ln2 ln interpolate interpolate_exp interpolate_lab interpolate_hcl sin cos tan asin acos atan atan2 pow exp log TAU length circle arc polygon linestring to_number to_string to_boolean to_color within distance collator_cmp resolved_locale |
| Evaluator special forms  | 3                                     | `get(…)` (dynamic + colon-bearing keys), `properties()`, `match(x){ p -> v, _ -> d }`                                                                                                                                                                                                                                                                                       |
| Camera identifiers       | 2                                     | `zoom`, `pitch`                                                                                                                                                                                                                                                                                                                                                             |
| Binary operators         | 14                                    | `+ - * / % == != < > <= >= && \|\| ??`                                                                                                                                                                                                                                                                                                                                      |
| Unary / other forms      | 7                                     | `- !`, ternary `?:`, pipe `x \| f(a)`, index `a[i]`, field `.f`/`o.f`, array+object literals                                                                                                                                                                                                                                                                                |
| **Total distinct forms** | **≈77**                               |                                                                                                                                                                                                                                                                                                                                                                             |

Plus **user-defined functions** (`fn name(a,b) { let…; if…; for i in 0..n {…}; return … }`, loop-capped at 10,000 iterations) — a capability **no peer's in-spec language has**, and **geometry generators** (`circle/arc/polygon/linestring`) that construct coordinates, also peer-unique.

**Peers** ⚠: Mapbox GL JS v3 ≈101 ops · MapLibre v5 ≈85 · OpenLayers flat ≈40 · CartoCSS: no general expressions (zoom/attribute selectors + ~20 color functions).

### 2.2 What XGIS lacks vs Mapbox/MapLibre (from the repo's own 58-row expression census, `convert/spec-coverage/expressions.ts`: 42 supported / 10 partial / 1 unsupported / 5 na)

- **No runtime color constructors**: `rgb/rgba/hsl/hsla` are convert-time constant-folded only (partial). CartoCSS has 20+ color ops; XGIS colors are hex strings end-to-end.
- **No `feature-state`** (na) — no declarative interaction/dynamic state at all (see D-L6).
- **`format` rich-text spans partial** — flattened to `concat`, per-span font-scale/color dropped.
- **`interpolate cubic-bezier` partial** — densified to 6-sample piecewise linear at compile time (good approximation, exact only for literal stops).
- **No variable binding in expressions** — Mapbox `let/var` is substituted away at convert time; XGIS surface syntax has no expression-local `let`.
- **`distance-from-center` unsupported** — the eval model has no per-frame×per-feature camera hook beyond zoom/pitch.
- Type-assertion ops (`array`, strict `number`/`string`) degrade to pass-through — connected to the silent-coercion problem (D-L3).

### 2.3 Zoom/time interpolation forms

XGIS: `interpolate(zoom,…)` linear · `interpolate_exp(zoom, base,…)` · `interpolate_lab/_hcl` · `step` N-stop · **time keyframes** · **zoom×time composed** (`PropertyShape kind:'zoom-time'`, verified by `fixture-x-zoom-time-opacity.xgis`). Mapbox: linear/exponential/cubic-bezier/hcl/lab over zoom or data — but **no time axis at all**.

**Verdict D1:** XGIS ≈77 forms vs Mapbox ≈101: ~76% of the raw inventory, but with three genuinely novel classes (fn/for, geometry generators, time axis) and three real holes (color constructors, feature-state, rich-text format). **XGIS 3.5 · Mapbox 4.5 · MapLibre 4.0 · CartoCSS 1.5 · OL flat 3.0.**

---

## 3. D2 — Ergonomics

### 3.1 Measured: the same real style, both languages

OpenFreeMap **Bright** (119 layers: 1 background, 22 fill, 71 line, 25 symbol), converted by this repo's own `convertMapboxStyle`:

| Metric     | Mapbox JSON (pretty) | Mapbox JSON (minified) | **XGIS**   | Ratio (pretty→XGIS)               |
| ---------- | -------------------- | ---------------------- | ---------- | --------------------------------- |
| Characters | 120,772              | 48,712                 | **40,384** | **3.0×** fewer (1.2× vs minified) |
| Lines      | 6,962                | 1                      | **917**    | **7.6×** fewer                    |

Single layer `highway-primary` (filter on 4 predicates + exponential zoom width):

| Metric               | Mapbox JSON | **XGIS** | Ratio        |
| -------------------- | ----------- | -------- | ------------ |
| Chars (pretty / min) | 970 / 471   | **376**  | 2.6× / 1.25× |
| Lines (pretty)       | 77          | **6**    | **12.8×**    |
| Lexical tokens       | ~214        | **~75**  | **2.9×**     |

```xgis
layer highway_primary {
  source: openmaptiles
  sourceLayer: "transportation"
  filter: (get("$geometryType") == "LineString" || …) && (.brunnel != "bridge" && .brunnel != "tunnel") && (.class == "primary") && (.ramp != 1)
  | stroke-round-cap stroke-round-join stroke-#fea stroke-[interpolate_exp(zoom, 1.2, 8.5, 0, 9, 0.5, 20, 18)]
}
```

An infix `filter:` line replaces a 45-line Lisp-in-JSON tree. A complete world map (`minimal.xgis`) is **9 lines of code**.

### 3.2 Comments, readability, quirks

- **Comments:** `//` and `/* */` (lexer.ts) — Mapbox/MapLibre JSON has **none** (a decade-old complaint); CartoCSS yes; OL flat no (JS-hosted).
- **Three spellings of the same intent** (inconsistency): data-driven fill can be `fill-sky-500` (utility), `fill-[expr]` (bracket binding), _or_ `fill match(.f) { … }` (space-form trailing expression, e.g. `categorical.xgis`, `income-match.xgis`); plus a fourth via CSS-ish `fill: slate-900` style-properties and `style` blocks. Too many synonyms for a 5-year surface (D-L11).
- **Stringly micro-grammar:** `stroke-2` (width) vs `stroke-rose-500` (color) vs `stroke-dasharray-16-8` are disambiguated by `parseFloat` inside a prefix ladder whose order matters (`lower-animation.ts:86` must dodge the `stroke-` prefix). `opacity-1` means 1.0 while `opacity-2` means 0.02 (`num <= 1 ? num : num/100`, `utility-resolver.ts:83`) — a spec-by-implementation cliff.
- **Grammar landmine:** in match-arm values, `Identifier` followed by `-` parses as a _utility color name_ (`parser-expressions.ts:347-352`), so `_ -> foo - 1` cannot be written — subtraction is unreachable there.
- Long label chains emit as 300+-char single lines (converted OFM country labels) — no sub-block grouping for the 32 `label-*` knobs.

**Verdict D2:** Best-in-class density and readability, measured, with fixable consistency debt. **XGIS 4.5 · Mapbox 2.0 · MapLibre 2.0 · CartoCSS 4.0 · OL flat 2.5.**

---

## 4. D3 — Validation & diagnostics

Measured XGIS reality:

| Stage        | Behavior                                                                                                                                                                                                       | Evidence                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Lexer/Parser | **Throws on first error**; message string `"[Parser] … at line L, col C"`; no recovery, no second error, no span/col struct                                                                                    | `parser-cursor.ts:61-63`               |
| Lower (IR)   | Collected `Diagnostic { severity: 'warn'\|'info', code?, line? }` — **no `error` level, no column**, **7 codes total** (X-GIS0001…0007)                                                                        | `ir/render-node.ts:44-53`              |
| Converter    | `warnings: string[]` + per-source/per-layer coverage collector + human notes trailer comment; **9 structural validators** (layer/source zoom sanity, id collisions, dangling source refs, source-layer checks) | `convert/validate-{layers,sources}.ts` |
| Runtime eval | **Silent coercion everywhere**: `toNumber("abc")=0`, ÷0→0, non-finite→0, and `callBuiltin` default branch **returns `args[0]` for any unknown function name** — a typo'd `sqrrt(.x)` silently yields `.x`      | `eval/evaluator-helpers.ts:513-514`    |
| Keyframes    | Unknown utilities **silently ignored**                                                                                                                                                                         | `ir/lower-animation.ts:121-122`        |

Peers ⚠: Mapbox/MapLibre ship `gl-style-validate` + in-library validation — every property checked against the versioned spec JSON, expression **compile-time type errors** with JSON paths (`layers[3].paint.line-width: number expected, string found`), editor surfacing in Maputnik/Studio. CartoCSS (carto) reports multiple errors with line/col. OL throws at runtime per-expression.

The strict deprecation diagnostic for the removed `z8:` modifier (X-GIS0001, fail-loud with migration text) shows the right instinct — but it is one hand-built case, not a system.

**Verdict D3: the widest gap in the comparison.** **XGIS 2.0 · Mapbox 4.5 · MapLibre 4.5 · CartoCSS 3.0 · OL flat 2.0.**

---

## 5. D4 — Modularity & reuse

XGIS has more reuse _constructs_ than any peer, but they are shallow and unused:

| Mechanism                                    | State                                                                                                                                                  | Evidence                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `import "url"` (splice)                      | **Live remote import with Mapbox auto-detect** (`version>=7 && layers[]` sniff → converter) — one line imports OpenFreeMap Bright, real killer feature | `module/resolver.ts:160-180`, `openfreemap-bright.xgis` |
| `import { a, b } from "f.xgis"` (named)      | Cherry-picks 6 statement kinds                                                                                                                         | resolver.ts:75-92                                       |
| **No recursion**                             | Nested imports **silently dropped** in splice form ("v1 doesn't ship a recursion guard")                                                               | resolver.ts:141-144                                     |
| No namespacing / aliasing / collision checks | Imported statements prepended; duplicate names unreported                                                                                              | resolver.ts:70                                          |
| `style` blocks                               | Only **4 properties** (fill, stroke, strokeWidth, opacity)                                                                                             | `schema/language.ts:119-133`                            |
| `preset` + `apply-name` mixins               | Implemented (inline expansion, `lower.ts:1300-1313`) — **0 uses in 136 examples**                                                                      | census §1                                               |
| `fn` / `let`                                 | Implemented — **0 uses in 136 examples**                                                                                                               | census §1                                               |
| Theming                                      | None (no variables/tokens beyond the fixed 242-color palette)                                                                                          | —                                                       |

Peers ⚠: Mapbox v8 **none** (copy-paste JSON); Mapbox v11 (proprietary) added `imports`+`config` fragments; MapLibre none in-spec; CartoCSS has `@variables` + nesting; OL flat none.

**Verdict D4:** structurally ahead of the JSON incumbents, but v1-depth. **XGIS 3.0 · Mapbox 2.0 (v11 imports) / 1.0 (v8) · MapLibre 1.0 · CartoCSS 3.5 · OL flat 1.0.**

---

## 6. D5 — Animation & time (the differentiator)

XGIS is the **only language in this comparison with in-spec animation**:

```xgis
keyframes heat { 0%: fill-slate-700 stroke-slate-500  50%: fill-rose-600 stroke-amber-300  100%: fill-slate-700 }
layer country_heat {
  source: countries
  | fill-slate-700 stroke-slate-500 stroke-1
  | animation-heat animation-duration-2000 animation-ease-in-out animation-infinite
}
```

- CSS-shaped: named `keyframes` (0%/`from`…100%/`to`), lifecycle utilities `animation-{name,duration-,ease-*,delay-,infinite}`; multiple properties per keyframe row.
- Composes with zoom: `zoom-time` PropertyShape multiplies zoom-interp × time-interp per frame.
- Measured limits: **6 animatable axes only** (opacity, fill color, stroke color, stroke width, size, dash-offset — `lower-animation.ts:20-27`) of the ~30 paint axes the language exposes; **4 easings** (`linear ease-in ease-out ease-in-out`, `render-node.ts:829`) — no `cubic-bezier()`, no spring; unknown keyframe utilities silently ignored; no per-keyframe easing; no state-change transitions (Mapbox's one time-ish feature, `transition` fades, is itself _unsupported_ by the importer).

Peers: Mapbox/MapLibre **no in-spec animation** (only ~300 ms `transition` fades on property _changes_; anything else is host-JS `setPaintProperty` loops) ⚠. CartoCSS none. OL none.

**Verdict D5: keep and formalize — this is the moat.** **XGIS 4.0 · everyone else 1.0-1.5.**

---

## 7. D6 — Interop / migration story

Live census of the Mapbox importer (`convert/spec-coverage/`, re-counted 2026-07-13 — the task brief's 176/18/42/7 is slightly stale):

| Status      | Count   | % of 243 |
| ----------- | ------- | -------- |
| supported   | **176** | 72.4%    |
| partial     | 20      | 8.2%     |
| unsupported | 35      | 14.4%    |
| na          | 12      | 4.9%     |

Highlights by section: layer types 8/11 usable (hillshade, sky unsupported; icon-only symbol partial) · sources 7/10 (image/video unsupported, raster-dem partial) · layout-symbol 44 rows with 35 supported · paint-line 10/11 (line-gradient missing) · expressions 42/58 supported · legacy filters 7/7. Top-level: sprite/glyphs/camera/`projection`/`light` forwarded; `terrain`/`fog`/`transition`/`imports` not.

Beyond the table, the migration story is unusually strong: **one-line live import of any MapLibre-ecosystem URL** (`import "https://tiles.openfreemap.org/styles/bright"`), conversion-notes trailer naming every dropped property, per-layer coverage collector, and a **spec oracle** that consults `@maplibre/maplibre-gl-style-spec` (dev-dep) for canonical defaults (`spec/oracle.ts`). Gaps: **one-way door** — no `.xgis → style.json` exporter exists (blueprint has `styleToGraph` for graphs, but there is no reverse compiler), and importer parity is only as good as the render subsystems behind it (heatmap/hillshade/terrain phases R per `docs/research/2026-06-19-mapbox-compat-roadmap.md`).

**Verdict D6:** **XGIS 4.0** as an importer (best-in-class migration on-ramp; no off-ramp). Peers: n/a as incumbents; CartoCSS 1.0 (dead end); OL 2.0.

---

## 8. D7 — Tooling surface

| Tool           | XGIS (measured)                                                                                                                                 | Mapbox ⚠                                                 | MapLibre ⚠                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| Editor support | `vscode-xgis`: **TextMate grammar only, 143 lines** — no LSP, no completions, no in-editor diagnostics                                          | Studio (GUI), JSON schema in IDEs                        | Maputnik (GUI)               |
| Visual editor  | `blueprint/` node-graph editor, catalogue **derived from `LANGUAGE_SCHEMA`** with a drift-guard contract test — architecturally excellent       | Studio                                                   | Maputnik                     |
| Playground     | 136-example live playground + `/play`, `/convert` pages                                                                                         | GL JS examples                                           | demo tiles                   |
| Formatter      | **none**                                                                                                                                        | n/a (JSON)                                               | n/a                          |
| CLI / validate | **none** (no `bin` in any workspace package.json)                                                                                               | `gl-style-validate`, `gl-style-format`                   | `maplibre-gl-style-spec` CLI |
| Schema         | `LANGUAGE_SCHEMA` covers **8 constructs, shallow** (blueprint contract); no normative grammar; `SPEC.md` is the _tile_ format, not the language | versioned spec JSON (the whole spec is machine-readable) | same                         |
| Fuzzing/tests  | parser fuzz test + spec-coverage drift gates exist                                                                                              | spec test suite                                          | same                         |

**Verdict D7:** **XGIS 2.5 · Mapbox 5.0 · MapLibre 4.5 · CartoCSS 2.0 (dead tooling) · OL 3.0.** The machine-readable-spec gap (Mapbox's spec _is_ a JSON document; XGIS's spec _is_ the parser) is the root cause of most of D3/D7.

---

## 9. Scorecard

| Dimension                   | XGIS    | Mapbox v8/v3 | MapLibre v5 | CartoCSS | OL flat |
| --------------------------- | ------- | ------------ | ----------- | -------- | ------- |
| D1 Expression power         | 3.5     | **4.5**      | 4.0         | 1.5      | 3.0     |
| D2 Ergonomics               | **4.5** | 2.0          | 2.0         | 4.0      | 2.5     |
| D3 Validation & diagnostics | 2.0     | **4.5**      | **4.5**     | 3.0      | 2.0     |
| D4 Modularity & reuse       | 3.0     | 2.0          | 1.0         | **3.5**  | 1.0     |
| D5 Animation & time         | **4.0** | 1.5          | 1.0         | 1.0      | 1.0     |
| D6 Interop / migration      | **4.0** | —            | —           | 1.0      | 2.0     |
| D7 Tooling                  | 2.5     | **5.0**      | 4.5         | 2.0      | 3.0     |

Identity: XGIS wins on **density, animation, and migration on-ramp**; it loses on **diagnostics, spec formality, and tooling depth** — exactly the axes that compound over a 5-year horizon, and exactly the ones that are cheapest to fix while user count is zero.

---

## 10. Language deficiencies — prioritized, breaking-OK redesign proposals

User count is zero: every proposal below assumes breaking changes are free except for the ~136 in-repo examples + fixtures (mechanically migratable) and the converter's emitter (single authority, one file cluster).

### L1 — No language version marker _(P0, foundation for every other break)_

**Problem:** `.xgis` files carry no version; the language has already made a breaking change (`z8:` modifiers removed) that is only detectable via a runtime warning (X-GIS0001). Five years of evolution with no version gate means every future break is silent corruption. Mapbox styles carry `"version": 8` for exactly this reason.
**Proposal:** mandatory first-statement pragma `xgis 1` (or `#!xgis/1`); parser hard-errors on missing/unknown major. Converter emits it.
**Migration cost:** one scripted pass over examples/fixtures + 1 line in the emitter. ~hours.

### L2 — Fail-fast, span-less, four-channel diagnostics _(P0)_

**Problem:** parser throws on the **first** error (string message, no recovery — `parser-cursor.ts:61`); lower emits warn/info only (no `error` severity, no columns, 7 codes); converter uses raw `string[]`; runtime eval never reports. Four disjoint channels, none span-carrying. gl-style-validate reports _all_ errors with paths.
**Proposal:** one `Diagnostic { code, severity: error|warn|info, span: {start,end}, message, help? }` shared by lexer→parser→lower→converter; parser error-recovery synchronizing on `}`/newline/next-keyword so a file reports N errors; tokens already carry line+col — extend to offsets. This is also the LSP substrate (L10).
**Migration cost:** internal API only; zero style breakage. ~days, highest leverage in the list.

### L3 — Silently-coercing, typo-forgiving expression semantics _(P0)_

**Problem:** `callBuiltin`'s default branch returns `args[0]` for **any unknown function name** (`evaluator-helpers.ts:513`) — `sqrrt(.x)` quietly evaluates to `.x`. `toNumber("abc")=0`, ÷0→0, non-finite→0. Mapbox expressions are compile-time _type-checked_; XGIS renders _something_ instead of failing. For a 5-year library this is a bug factory (the repo's own iter-531/536/293 fix trail is this class).
**Proposal:** (a) unknown function = `error` diagnostic at lower time (the builtin name set is closed and known); (b) a lightweight static type pass over `DataExpr` (types are just number/string/bool/color/array) with `error` on impossible coercions; (c) keep the defensive runtime coercions as a _second_ line, not the contract.
**Migration cost:** zero for valid styles; fixture corpus re-run catches latent typos (a feature, not a cost).

### L4 — Stringly utility micro-grammar with no single authority _(P1)_

**Problem:** 78 utility prefixes are dispatched by ordered `startsWith` ladders duplicated across `lower.ts`, `lower-label.ts`, `lower-animation.ts`, `utility-resolver.ts`; keyframes silently ignore unknown names; `opacity-1`=1.0 vs `opacity-2`=0.02; width-vs-color decided by `parseFloat`. The registry idea already half-exists (`lower-bindings-registry.ts`).
**Proposal:** one declarative utility table `{ prefix, value-kind (color|number|enum|expr), unit-rule, animatable?, applies-to }` that _generates_ the lowering dispatch, keyframe validation, docs page, TextMate patterns and LSP completions. Unknown utility = error everywhere (extend X-GIS0005/0006 to keyframes). Fix the 0-1/0-100 opacity cliff by picking one scale (suggest 0-100 integers + `opacity-[expr]` for fractions).
**Migration cost:** examples using `opacity-0.9` style fractions (heatmap.xgis etc.) need a scripted rewrite; otherwise internal.

### L5 — `match{}` arms are single stringified patterns _(P1)_

**Problem:** one pattern per arm, matched by `String(key)` compare (`evaluator.ts:313-324`); no multi-value arm (`"a" | "b" ->`), no typed numeric match, and the arm-value grammar can't express `ident - expr` (identifier+minus parses as a utility color name, `parser-expressions.ts:347`). Mapbox `match` takes value _lists_ per branch; the converter has to expand them into repeated arms.
**Proposal:** `pattern ("," | "|" pattern)* -> value` arm lists; keep `_` default; type the comparison (number patterns compare numerically); resolve the identifier-minus ambiguity by requiring utility-name values to be color literals or by whitespace-sensitivity removal (bracket the expression).
**Migration cost:** none for existing styles (superset), converter emitter simplifies.

### L6 — No declarative interaction state (`feature-state` equivalent) _(P1)_

**Problem:** the modifier grammar (`hover:fill-…`) parses, but semantics are "feature-property predicate" only; Mapbox `feature-state` is `na` in the census; hover/selection styling requires host JS. A Google-Earth-grade engine needs declarative interactive states; XGIS already has picking + `pointer-events-*`.
**Proposal:** formalize a small state axis: `hover:` / `active:` / `selected:` modifiers (CSS-pseudo-class shaped, consistent with the Tailwind idiom) backed by a runtime per-feature state store (`map.setFeatureState` analogue); states compose with the animation system (`transition-*` utilities, see L7) so hover fades are declarative too.
**Migration cost:** additive; reserves modifier names that currently fall through to property-predicates (breaking-OK).

### L7 — Animation covers 6 of ~30 axes, 4 easings _(P1 — invest in the moat)_

**Problem:** keyframes expand into exactly 6 time-stop arrays (`lower-animation.ts:20-27`); label/icon/translate/extrusion/heatmap axes are not animatable; easing is 4 CSS presets, no `cubic-bezier(a,b,c,d)` (ironically the _importer_ already densifies beziers); unknown keyframe utilities silently ignored; no per-keyframe easing; no property-change transitions.
**Proposal:** route keyframe expansion through the same utility registry (L4) so **every `PropertyShape` axis is animatable by construction**; add `cubic-bezier` + `spring` easings; per-keyframe easing (`50% ease-out:`); `transition-<prop>-<ms>` utilities for state changes (pairs with L6). Publish this as the flagship spec chapter — no peer can follow without a spec revision.
**Migration cost:** additive; existing keyframes unchanged.

### L8 — Import system is v1: no recursion, no namespaces, no collision handling _(P2)_

**Problem:** nested imports are silently dropped (`resolver.ts:141-144`); no `as` aliasing; imported symbols prepend with no duplicate detection; file-not-found throws mid-parse. Fine for demos, not for a style ecosystem (themes importing base styles importing shared palettes).
**Proposal:** recursive resolution with cycle detection (path stack); `import * as base from "…"` + `base.layername` references; collision = error diagnostic; imports become part of the diagnostics channel (L2), not exceptions.
**Migration cost:** additive; splice form keeps working.

### L9 — Vestigial surface: 8 reserved keywords + 4 zero-use constructs _(P2, cheap while free)_

**Problem:** `place view on struct enum simulate analyze export` are tokenized but unimplemented; `show`, `preset`, `fn`, `let` are implemented but have **0 uses across 136 examples**; `style` blocks support only 4 properties. Every one of these is future breaking-change debt and parser/LSP surface.
**Proposal:** delete the 8 unimplemented keywords (identifiers again); delete legacy `show` (the `layer` form superseded it); either promote `preset`/`style` into one unified, full-surface `preset` (any utility line, referenced by `apply-…` _and_ `style:`) or delete both; keep `fn`/`let` only if the L3 type pass covers them.
**Migration cost:** zero (nothing uses them) — this is exactly the pruning that is free now and expensive in year 3.

### L10 — No normative grammar, no conformance corpus, thin tooling _(P2)_

**Problem:** the grammar exists only as the hand-written recursive-descent parser; `LANGUAGE_SCHEMA` covers 8 constructs shallowly (editor contract); root `SPEC.md` documents the _tile format_, not the language; no formatter, no CLI, no LSP.
**Proposal:** write `docs/spec/xgis-language.md` (EBNF + semantics per construct, versioned with L1); generate a conformance fixture corpus (valid + invalid-with-expected-diagnostic pairs — the spec-wiring-corpus pattern this repo already uses); ship `xgis` CLI (`validate`, `fmt`, `convert`) and an LSP fed by L2 diagnostics + L4 registry completions.
**Migration cost:** documentation + tooling only.

### L11 — Too many synonyms for one intent _(P3, polish)_

**Problem:** fill can be authored 4 ways (utility, bracket-binding, space-form `fill match(...)`, `fill:` style-property). Pick canonical forms before muscle memory forms.
**Proposal:** canonical = utility + bracket-binding; keep `fill match(){…}` as the one blessed block-expression sugar; fold `style:`/`styleProperties` into presets (L9).
**Migration cost:** scripted rewrite of ~10 examples.

---

## Appendix — raw numbers cited above

- Evaluator builtins: 51 canonical + aliases (`index-of`, `number-format`, `PI`, `number`, `string`, `boolean`) — `eval/evaluator-helpers.ts:14-516`.
- Coverage census (live): 243 rows = 176 supported / 20 partial / 35 unsupported / 12 na; expressions 58 rows (42/10/1/5); sections: expressions 58, layout-symbol 44, top-level 17, paint-symbol 14, paint-line 11, layer-types 11, paint-circle 11, source-types 10, fill-extrusion 10, hillshade 9, raster 9, layer-common 9, layout-fill-line 8, paint-fill 7, filters 7, heatmap 5, paint-background 3.
- OFM Bright conversion run: 119 Mapbox layers → 121 xgis layers + 1 source + background; 3 conversion notes; converter dropped 1 unused raster source by design.
- Diagnostics codes in use: X-GIS0001 (deprecated zoom modifier), 0002, 0003, 0005 (unknown binding utility catch-all), 0006 (label catch-all), 0007 — 7 total.
- Peer op counts are ⚠ training knowledge (Mapbox GL JS v3 ≈101; MapLibre v5 ≈85; OL flat ≈40; CartoCSS n/a) — verify against the live spec repos before publishing externally.
