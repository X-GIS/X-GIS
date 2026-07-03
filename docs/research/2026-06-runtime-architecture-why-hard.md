# Why the current runtime is hard to debug and expensive to extend — a Blender-grounded analysis

_Deep-research synthesis, 2026-06-08. Five web-researched angles (invalidation correctness, Blender depsgraph, Blender draw manager, GPU-renderer testing, cost-of-change) merged with the X-GIS runtime as the concrete case. Claims are cited inline; confidence and caveats are carried from the source verification pass. This is an explanatory/architecture document — it prescribes nothing that isn't already underway in the invalidation-perf phase._

---

## TL;DR — the thesis in one paragraph

X-GIS's runtime has, until very recently, expressed "something changed" as a **single coarse dirty flag** (`invalidate()` → `_needsRender`) and **fused scene/label evaluation with drawing in one render loop**. That combination is the root of two felt problems. (1) **Bugs are hard to catch** because a monolithic flag _cannot say which thing is stale_ — so a missed invalidation (the change that should redraw but doesn't) is silent, intermittent, and timing-dependent, which is exactly the class of bug that does not reproduce in a deterministic unit test. The S16 label-skip staleness bug fixed this session (async glyph/sprite landing + time-driven labels failing to re-collate) is a textbook instance. (2) **Features and refactors are expensive** because tight coupling gives every change a large blast radius — the reversed-Z depth fix (#4), for example, has to touch _every_ pipeline's depth state atomically. Blender solved the analogous problems with an **explicit dependency graph (depsgraph)** that separates _tagging_ from _evaluation_ at component granularity, and a **draw manager** that separates evaluated-scene data from drawing so render engines are cheap pluggable consumers. The invalidation-perf phase already in flight (per-domain dirty bitset, `post_change` oracle, S14/S16) is the first step down that same path.

---

## 1. Why the current invalidation structure hides bugs

**"Cache invalidation" is famously one of the two hard problems** (attributed to Phil Karlton [1]) for a concrete reason that applies directly here: a dirty flag is _derived-data bookkeeping_ — primary data changes, expensive derived data must be recomputed, and a boolean tracks whether they're in sync [2, Nystrom, _Game Programming Patterns_]. The failure mode is structural: **"forgetting to set the dirty flag in even one place" yields stale derived data and "bugs that are very hard to track down"** [2].

The browser-engine literature names the two halves precisely [3, browser.engineering/invalidation.html — primary, high-confidence]:

- **Under-invalidation** = "forgetting to set the dirty flag on a field when you change a dependency." Its signature is that the bug **"typically only shows up if you make a very specific sequence of changes,"** sometimes manifesting as a change that **"needs to happen multiple times to finally 'take'"** (accidental non-idempotency), and the visible result is **"unpredictable layout glitches" that "can be very hard to debug"** [3]. The word _sometimes_ is the whole problem — it is intermittent and sequence/timing-dependent.
- **Over-invalidation** = protected fields that are too coarse, so an unrelated change (e.g. `opacity`) needlessly recomputes everything (e.g. the whole layout tree). This is a _performance_ symptom, and the remedy is **fine-graining** one coarse field into per-property fields [3].

**Why a single global flag is the worst case for the first half.** A monolithic `_needsRender` boolean is maximally coarse: it can record _that_ something is dirty but not _which_ domain. So it cannot help you reason about whether a given state change is covered — every "should this redraw?" question is answered by hand, and "it's easy to forget to check or set a dirty flag, which leads to hard-to-find bugs" [3]. The granularity itself is an explicit correctness/performance axis: coarser = less memory but processes unchanged data; finer = processes "only data that actually changed" [2].

**The contrast that eliminates the bug class: dependency-driven invalidation.** Frameworks that track dependencies _automatically on read_ don't have the "forgot to mark dirty" footgun at all. SwiftUI's AttributeGraph registers a dependency when `body` reads a state's value, marks that attribute dirty on write, cascades dirtiness only to dependents, and recomputes only dirty nodes — "if the dependency changes, only those views will be invalidated" [4, med-confidence, secondary]. Because the dependency edges are _derived from actual reads_ rather than _manually asserted_, the under-invalidation class is structurally prevented. (This is the same idea as Blender's depsgraph, §2.)

**A testability technique worth stealing.** browser.engineering recommends **asserting a field is clean before each read** ("assert before using protected fields… coding defensively like this catches bugs earlier") [3]. The render-side analog — _assert that a redraw/re-collation actually happened after a known state change_ — is exactly what the `post_change` oracle added this session does, and is the correct response to under-invalidation.

> **X-GIS grounding.** The runtime expressed change as `invalidate()` → `_needsRender` (one flag), only recently gaining a per-domain dirty bitset (`_markDirty(domains)`, S14) and its first eval-side consumer (S16's label-collision skip). The S16 _staleness_ bug fixed this session — the skip didn't re-collate when glyph/sprite atlases landed asynchronously or when a label was time-driven — is precisely claim [3]'s under-invalidation: a dependency (async resource state, animation clock) changed, the dirty bookkeeping didn't capture it, and the result was an intermittent stale frame that only appeared under a specific timing sequence. A coarse flag can't express "LABEL domain is stale because glyphs just resolved," so the bug was invisible to the skip logic and to any non-timing-dependent test.

---

## 2. The reference design — Blender's dependency graph (depsgraph)

Blender faced the same problem at vastly larger scale and answered it with an **explicit graph whose nodes are scene entities and whose edges are the relations between them** [5, official depsgraph design wiki — high]. Four properties of that design are the direct antidote to a monolithic flag:

1. **Explicit, inspectable relations.** It is a DAG of datablocks with cycle detection at build time [6, med], and crucially it is _debuggable_: the depsgraph debug add-on dumps the graph via `SCENE_OT_depsgraph_relations_graphviz` to Graphviz `.dot`/PNG/SVG [7, blender-addons source — high]. Dependencies are **visualizable rather than implicit** — the opposite of "reason about every redraw by hand."

2. **Component granularity, not object granularity.** Each datablock splits into `ComponentNode`s — Transform (parenting/constraints) vs Geometry (modifier stack) — which evaluate independently [8, deepwiki + headers — high]. The **pre-2.8 system evaluated an object as a whole** and this coarseness is what caused both wasted work and unresolvable dependency cycles; splitting transform-vs-data is what fixed it [9, 10, med — official docs 403'd, snippet-sourced]. This is "fine-graining" [3] applied at the scene-graph level.

3. **Tagging is separate from evaluation.** Change marks data dirty via `DEG_id_tag_update()` with **typed** flags — `ID_RECALC_TRANSFORM`, `ID_RECALC_GEOMETRY`, `ID_RECALC_ANIMATION` — and the actual computation happens _later_ in a distinct pass (`DEG_evaluate_on_refresh()` / `_on_framechange()`) that flushes tags through the affected subgraph [11, 12, wiki-dump + headers — high]. The payoff is stated verbatim: the graph **"only updates what was dependent on the modified value and will not update anything which was not changed"** [5]. Typed tags are what _couple a change to the specific component that must recompute_ — the thing a boolean cannot do.

4. **A hard original-vs-evaluated boundary (copy-on-write / "copy-on-eval").** Evaluation runs on a _copy_; "none of the changes are applied on the original DNA" [5], and the API enforces the split (`DEG_get_evaluated_id()`, `DEG_is_original_id()`/`_is_evaluated_id()`) [13, current header — high]. COW exists specifically "to support data to be in different states at the same time" and to resolve render-vs-viewport threading conflicts [5] — i.e. it is also what makes the data _safe to share_, which §3 builds on.

> **X-GIS grounding.** X-GIS has no explicit relation graph; "what depends on what" lives implicitly in the imperative render loop. The S14 per-domain dirty bitset is the embryonic form of Blender's _typed_ `ID_RECALC_*` tags, and S16 is the first consumer that re-evaluates _only_ its domain when _only_ its tag is clean — exactly depsgraph's "update only what changed." The natural trajectory is: more typed domains, more eval-side consumers keying off them, and eventually an explicit (even if coarse) dependency description that can be asserted and inspected the way the Graphviz dump is.

---

## 3. The other half of the boundary — Blender's draw manager / engine separation

Blender doesn't just separate _tag from evaluate_; it separates _evaluated-scene from drawing_. The **depsgraph produces evaluated data; the Draw Manager (DRW) consumes it; render engines are pluggable consumers** of a defined API [14, deepwiki — high]:

- Engines **"work with generated data provided by the dependency graph and never touch original DNA"** and **"will simply not care about where the data is coming from"** [5] — total isolation of engine from scene-eval.
- In DRW, **"passes are independent blocks of rendering commands"** and **"all low-level optimisation is done by the DRW module under the hood"** [15, Dev:2.8 Draw Manager wiki — high] — engines declare _what_ to draw; DRW owns batching/state-sorting/caching. The scene render state **"is cached for fast redraw"** and reused until materials/objects change [16, med — 2017 design intent, shipped in 2.8].
- The engine API is small and shared: a realtime path + a final-render path, outputting to a buffer that shared infrastructure composites with overlays [17, EngineAPI wiki — high]. The proof it lowers cost is empirical: **Clay, Workbench, EEVEE, and Cycles all build on the same boundary** [17, 18], reusing one evaluated scene and one draw cache.

> **X-GIS grounding.** X-GIS _fuses_ evaluation (label collision, glyph/sprite resolution, `prepare()`) with drawing in one loop. That's why S16 had to be a _skip inside the render path_ rather than a clean "evaluation is up-to-date, just replay the draw" — there is no architectural seam between "the scene is evaluated" and "draw it." Blender's seam (evaluated data ↔ DRW ↔ engine) is exactly what would let label evaluation be cached and skipped _structurally_ instead of via a hand-placed guard, and it's the same seam that makes adding a render feature cheap (§4).

---

## 4. Why GPU renderers like this are hard to _test_

Even with perfect invalidation, X-GIS inherits the generic difficulty that **GPU correctness is defined by pixels, for which there is no cheap CPU oracle** — the classic test-oracle problem, where human inspection is "expensive and error-prone" [19, high]. The practical consequences, all primary-sourced:

- **The only real oracle is a pre-blessed reference image** (golden-image regression) [20], and exact pixel matching is brittle: floating-point non-associativity plus per-vendor FMA/rounding/"fast-math" mean identical inputs can produce slightly different pixels across hardware [21, 22, med — mechanism solid, sourced from ML/forum not graphics primary]. Chromium's own Gold system keeps **multiple approved images per test** because "tests… produce images that are visually indistinguishable but differ in a handful of pixels," and offers opt-in fuzzy matching [23, 24, Chromium docs — high].
- **Software-GPU CI diverges from real hardware.** Chromium runs SwiftShader so GPU-less bots "behave as if running on a regular GPU" [25, high], but software rasterizers have documented gaps — Mesa's Lavapipe has precision-related CI baseline failures and missing features [26, med]; llvmpipe output is even CPU-feature-dependent [27, Mesa docs — high]. **So software-GPU CI cannot catch hardware-only issues.**
- **The CTS-style mitigation: assert structure, not just pixels.** The WebGPU CTS frequently verifies rendering by **writing to a storage buffer and asserting on buffer contents** rather than comparing pixels [28, gpuweb CTS — high]. The map-renderer concrete pattern is MapLibre's render tests: `style.json` → `expected.png`, pass/fail by a **pixel-difference threshold** with per-test ignores, tolerant enough to span GL and Metal backends [29, 30, high]. Anti-alias-aware perceptual diffing (pixelmatch, used by Playwright) is what keeps such tests alive across hardware noise [31, high].

> **X-GIS grounding.** This is the exact reason the matrix gate is **real-GPU, local/pre-push only** — and this session I _measured_ the sharp edge of [25–27]: flat synthetic fills render 56.75% under SwiftShader, but the **same geometry extruded renders 0.00%** — the 3D extrude/depth pipeline does not rasterize under software GPU. That single fact is why the reversed-Z fix (#4) and its depth-ordering oracle (#4b) are desktop-only: CI's SwiftShader is in the "cannot catch hardware-only issues" regime [25]. The mitigations X-GIS already uses are straight out of this literature: the matrix gate _is_ the MapLibre golden-image pattern [29], and the `frame_stability`/`post_change` oracles are the CTS "assert behavior/structure, not just pixels" pattern [28] — they check _that the renderer reacted correctly_, sidestepping the brittle exact-pixel oracle.

---

## 5. Why adding features and refactoring costs more

The cost problem is the coupling problem, and there's a near-perfect industry case study. Frostbite's pre-FrameGraph renderer **"organically grew from 4k to 15k SLOC" with "single functions over 2k SLOC,"** was "expensive to maintain, extend and merge," and the named cause was **"tight coupling between rendering systems"** forcing teams to "fork/diverge to customize" [32, Frostbite GDC 2017 (O'Donnell) — high, primary]. Moving to a **render graph** — each pass _declares_ the resources it reads/writes/creates, and a separate compile phase schedules execution, allocates resources, and derives barriers — cut the WorldRenderer **from 15K to 5K SLOC** [32]. The mechanism is the same separation Blender uses: **declare _what_, let the engine decide _how/when_**. Coupling between modules is "controlled" via a blackboard rather than direct dependencies [32], reordering a pass to async compute becomes a one-line change [32], and the graph derives memory aliasing (570 MB saved at 4K) and synchronization automatically — capabilities that are "impractical to achieve safely by hand" because they need global knowledge of every pass [32, 33, Granite render-graph — high]. Render graphs are now de-facto standard (Unreal RDG, Anvil) [34, med].

The general principle behind the case study: **coupling exists "when changing one module requires changing another"** [35, Fowler — high, architectural argument], and tight coupling is the mechanism by which one change ripples across modules and raises cost. Internal-quality decay produces a **"cost of change" curve** where each new feature takes longer to fit and introduces bugs that take longer to fix [36, med]. Empirically, coupling/cohesion/size predict maintainability and change-/fault-proneness (effect sizes vary by study) [37, med]; **mutable global state is associated with higher defect-proneness and harms testability** because tests must configure shared state and identical calls can return different results [38, 39, IEEE — med, paywalled]; and loosely-coupled architecture is a validated DORA capability for higher delivery throughput and lower change-failure rate (directional; specific figures from the underlying State-of-DevOps reports) [40, med].

> **X-GIS grounding.** The reversed-Z fix (#4) is the cost curve made concrete: because depth state is _coupled across every pipeline_, the change must atomically touch the projection depth row, the depth-texture format, every `depthClearValue`, every `depthCompare`, and the `depthBias` signs — "if any single site is missed, geometry inverts/disappears." That large, indivisible blast radius is the [35] coupling tax. A render-graph-style seam (passes declaring depth usage; a depth convention owned in one place) is exactly what would shrink #4 from "edit N coupled sites and pray" to "change one declaration." The same is true of why the matrix gate is the _only_ way to validate it — there's no decoupled depth module to unit-test in isolation.

---

## 6. What this means for X-GIS (grounded, not speculative)

The two felt problems — _bugs are hard to catch_, _changes are expensive_ — are the two faces of one missing structure: **an explicit boundary between "what changed / what is evaluated" and "how it's drawn."** Blender's depsgraph (§2) and draw manager (§3) are the two halves of that boundary; the Frostbite render graph (§5) is the drawing half generalized. X-GIS is, encouragingly, already walking toward it:

- **S14 per-domain dirty bitset** ≈ Blender's typed `ID_RECALC_*` tags — the start of "say _which_ thing is stale" [11].
- **S16 eval-side skip** ≈ depsgraph's "update only what changed" [5] — the first consumer of those tags.
- **`post_change` oracle** ≈ browser.engineering's "assert the recompute happened" [3] and CTS's "assert behavior not pixels" [28] — the correct test for under-invalidation.
- **The matrix gate** ≈ MapLibre render tests [29] — the right (and only) oracle for a real-GPU renderer.

The highest-leverage _next_ structural steps (consistent with the existing roadmap, not new scope): (a) keep widening the typed dirty domains and routing every state mutation through them, so "did I cover this change?" becomes inspectable rather than hand-reasoned; (b) carve a seam between scene/label _evaluation_ and _drawing_ so up-to-date evaluation can be skipped structurally (not via in-loop guards); and (c) where depth/pass state is coupled (#4), pull the convention into one owned place so its blast radius collapses. None of these requires a rewrite — they are the direction S14/S16 already point.

---

## Sources

1. Fowler, _TwoHardThings_ — Karlton attribution. https://martinfowler.com/bliki/TwoHardThings.html
2. Nystrom, _Game Programming Patterns_ — Dirty Flag. https://gameprogrammingpatterns.com/dirty-flag.html
3. _Web Browser Engineering_ — Invalidation (under/over-invalidation, assertions). https://browser.engineering/invalidation.html
4. SwiftUI AttributeGraph redraw (secondary). https://medium.com/@matgnt/swiftui-redraw-system-in-depth-attributes-recomputation-diffing-and-observation-66b469fdcada
5. Blender depsgraph design (wiki dump). https://julianeisel.github.io/wiki.blender.org-dump/wiki/Source/Depsgraph.html
6. depsgraph DAG / cycle detection (deepwiki). https://deepwiki.com/blender/blender/10.2-dependency-graph
7. Blender depsgraph debug add-on (Graphviz dump). https://github.com/blender/blender-addons/blob/main/depsgraph_debug.py
8. IDNode→ComponentNode→OperationNode hierarchy. https://deepwiki.com/blender/blender/10.2-dependency-graph
   9–10, 12–14. Blender 2.80 depsgraph release notes / core docs (snippet-sourced; official URLs 403). https://developer.blender.org/docs/features/core/depsgraph/ · https://developer.blender.org/docs/release_notes/2.80/depsgraph/
9. Brecht depsgraph notes / `DEG_depsgraph.hh` (tag vs evaluate). https://julianeisel.github.io/wiki.blender.org-dump/wiki/User:Brecht/Depsgraph.html
10. `DEG_depsgraph_query.hh` (original vs evaluated API). https://raw.githubusercontent.com/blender/blender/main/source/blender/depsgraph/DEG_depsgraph_query.hh
11. Blender rendering engines / DRW vs RE API. https://deepwiki.com/blender/blender/9-rendering-engines
    15–16. Dev:2.8 Draw Manager (passes, DRW optimisation, cache). https://wiki.blender.jp/Dev:2.8/Source/Viewport/DrawManager
12. Dev:2.8 Viewport Engine API. https://wiki.blender.jp/Dev:2.8/Source/Viewport/EngineAPI
13. Dev:2.8 External Engines (engines consume depsgraph). https://wiki.blender.jp/Dev:2.8/Source/Viewport/ExternalEngines
14. Test oracle problem. https://en.wikipedia.org/wiki/Test_oracle
15. Image-comparison oracle for regression testing. https://www.researchgate.net/publication/300540397
    21–22. FP non-associativity / hardware FP divergence (mechanism; secondary). https://news.ycombinator.com/item?id=37007906
    23–24. Chromium GPU pixel testing with Gold (multiple approved images, fuzzy matching). https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/gpu_pixel_testing_with_gold.md
16. Chromium SwiftShader doc. https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md
17. Mesa Lavapipe CI baseline gaps (Vulkanised 2025, Igalia). https://vulkan.org/user/pages/09.events/vulkanised-2025/T5-Lucas-Fryzek-Igalia.pdf
18. Mesa llvmpipe doc (CPU-feature dependence). https://docs.mesa3d.org/drivers/llvmpipe.html
19. WebGPU CTS intro (assert buffer contents, not pixels). https://gpuweb.github.io/cts/docs/intro/
20. MapLibre Native render tests (style→expected.png, threshold). https://maplibre.org/maplibre-native/docs/book/render-tests.html
21. MapLibre GL/Native cross-backend pixel tolerance. https://github.com/maplibre/maplibre-native/issues/350
22. pixelmatch (AA-aware perceptual diff; Playwright). https://github.com/mapbox/pixelmatch
23. Frostbite _FrameGraph: Extensible Rendering Architecture_ (GDC 2017, O'Donnell). https://www.slideshare.net/slideshow/framegraph-extensible-rendering-architecture-in-frostbite/72795495
24. Granite render-graph deep dive (Arntzen). https://themaister.net/blog/2017/08/15/render-graphs-and-vulkan-a-deep-dive/
25. Render graphs as de-facto standard (educational; med). https://logins.github.io/graphics/2021/05/31/RenderGraphs.html
26. Fowler, _Reducing Coupling_ (IEEE Software). https://martinfowler.com/ieeeSoftware/coupling.pdf
27. Fowler, high-quality software is cheaper (reported). https://www.theregister.com/2019/05/31/high_quality_software_is_cheaper_says_refactoring_expert_martin_fowler/
28. Al Dallal, empirical maintainability/coupling correlation. https://thesai.org/Downloads/Volume8No3/Paper_27-An_Empirical_Investigation_of_the_Correlation.pdf
    38–39. Mutable global state → defect-proneness/testability (IEEE; paywalled). https://ieeexplore.ieee.org/document/9118816
29. DORA — loosely coupled architecture capability. https://dora.dev/capabilities/loosely-coupled-teams/

_Confidence: §1, §2, §4, §5 rest on primary high-confidence sources (browser.engineering, Blender headers/wiki, Chromium/Mesa/CTS/MapLibre docs, the Frostbite talk). Lower-confidence items are flagged inline — the pre-2.8 Blender contrast and several official Blender pages were 403-blocked and snippet-sourced; FP-nondeterminism is cited as principle; DORA effect sizes are directional._
