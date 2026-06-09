# A6 — Compiler↔Runtime Contract, Error/Observability, and the Axes a 5yr/3D/4D Goal Makes Critical

*Adversarial architecture audit, 2026-06-09. Every claim below is FACT (verified by direct read/grep, file:line cited) or INFERENCE (labelled). No vibes. Verdicts are cold.*

---

## VERDICT (this axis): **2 / 5** on 5-year sustainability

The compiler↔runtime seam is the **least type-safe boundary in the codebase** and it is *structural, not incidental* — the producer has the type, the boundary deliberately throws it away, and there is no version handshake to catch the resulting drift. Error handling **detects-but-does-not-act**: device loss is observed and then the renderer permanently dies; there is no `'error'` event for an embedding app. And the additional axes a 5-year / 3D-tiles / 4D-city ambition needs — **publishability, plugin extensibility, type-safety at the seam, determinism, time/4D rigor** — are each demonstrably weak *today*, with the packaging gap being a hard "cannot ship" rather than a "could be nicer."

It is not a 1: the raw materials of a good contract exist (a real consumer-driven contract test in `blueprint/`, a within-compiler WGSL oracle, an event registry, device-loss *detection*). They are simply pointed at the wrong boundary or stop one step short of acting. It is not a 3: the headline artifacts are duplicated-by-hand, untyped at the wire, unversioned, and the package cannot be `npm install`ed — those are load-bearing structural defects, not polish.

---

## PART 1 — The compiler↔runtime CONTRACT seams

### Pipeline (FACT)
`.xgis` source → compiler parse → IR `lower()` (`compiler/src/ir/lower.ts`, 2184 LOC) → `emitCommands()` → `SceneCommands { loads, shows, symbols?, background?, palette? }` (`compiler/src/ir/emit-commands.ts:182`) → runtime `VTR.render()`. The unit of paint is `ShowCommand`.

### C1 — `ShowCommand` is defined **twice, independently, with no shared type** — HIGH (drift risk) — FACT
Two parallel `export interface ShowCommand`:
- Producer: `compiler/src/ir/emit-commands.ts:41`
- Consumer: `runtime/src/engine/render/renderer-types.ts:52`

The consumer's own comment admits the hand-sync contract: *"Mirrors the compiler-side `ShowCommand.renderNodeIndex` at emit-commands.ts:41"* (`renderer-types.ts:59`). The compiler does **not** import the runtime type and the runtime does **not** import the compiler's `ShowCommand` (`renderer.ts:22` imports `ShowCommand` from `./renderer-types`, the local copy). They type-check against isolated definitions; a field rename on one side compiles clean and only surfaces at runtime.

### C2 — The duplication is **wider than `ShowCommand`** — HIGH — FACT (new this audit)
`LoadCommand` and `SceneCommands` are *also* duplicated:
- `compiler/src/ir/emit-commands.ts:19` (`LoadCommand`), `:182` (`SceneCommands`)
- `runtime/src/engine/interpreter.ts:49` (`LoadCommand`), `:77` (`SceneCommands`)

And again the comment betrays the hand-sync regime: the runtime `LoadCommand` says *"Mirrors the compiler-side LoadCommand at emit-commands.ts:29"* (`interpreter.ts:58`) — while also documenting that the two copies have **deliberately divergent fields** (the runtime `LoadCommand` intentionally omits `crs`, `interpreter.ts:67-74`). So this is not even "keep them identical"; it is "keep them *selectively* identical by hand," which is strictly worse — the diff is intentional in one field and accidental drift everywhere else, and nothing distinguishes the two at compile time.

### C3 — The expression payload crosses as `{ ast: unknown }` — HIGH (the defining property of the seam) — FACT
On the **runtime** side the per-feature expression is fully untyped at the wire. `{ ast: unknown }` appears **7 times** in `renderer-types.ts`:
- `strokeWidthExpr?: { ast: unknown }` (`renderer-types.ts:114`)
- `strokeColorExpr?: { ast: unknown }` (`:127`)
- `filterExpr?: { ast: unknown } | null` (`:161`), `geometryExpr?` (`:162`), `sizeExpr?` (`:163`)
- `extrude … { kind: 'feature'; expr: { ast: unknown }; fallback }` (`:176`)
- `extrudeBase … expr: { ast: unknown }` (`:182`)

The runtime then **double-casts through `unknown`** to interpret it:
```
new Node<'vec4<f32>'>(variant.fillExpr.expr as unknown as RuntimeExpr)   // renderer.ts:97
new Node<'vec4<f32>'>(variant.strokeExpr.expr as unknown as RuntimeExpr) // renderer.ts:101
```
A double assertion through `unknown` erases type history — TypeScript has nothing to check the producer's actual shape against. The renderer.ts:90-93 comment is candid: *"TypeScript treats them as nominally different types … Cast through `unknown` at the seam — the structural mirroring is pinned by the node-to-wgsl round-trip test."* The safety is asserted, not checked.

**The sharp nuance (FACT, and it makes the case worse, not better):** the type *exists on the producer*. `compiler/src/ir/render-node.ts:658-661` defines `DataExpr { ast: import('../parser/ast').Expr; classification? }` — i.e. the compiler **knows** the AST type internally. In `lower.ts` the AST is boxed as `{ ast: item.binding }` at ~14 sites (`lower.ts:671,675,683,718,736,817,885,888,893,895,897,899,913,1373` plus `:1676-1677`), and `item.binding` is the typed parser node. So the boundary doesn't *lack* the type — it **deliberately discards** it (`Expr` → `unknown`) when crossing into the runtime copy. A producer-side AST reshape therefore type-checks on both sides and breaks only when the runtime walks the wrong shape at render time. (`compiler/src/ir/render-node.ts:408` also boxes `iconImageExpr?: { ast: unknown }` — even the *compiler's own* `RenderNode` erases the type for the icon path, so the erasure is not purely a cross-package artifact.)

### C4 — **No version / compatibility field** on the artifact — MEDIUM — FACT
Grep for `schemaVersion|compilerVersion|contractVersion|irVersion|formatVersion` across the repo returns **zero hits in `renderer-types.ts`, `emit-commands.ts`, `interpreter.ts`, or `shared/`** (the only matches are in `docs/` and unrelated e2e snapshot fixtures). `SceneCommands` (`emit-commands.ts:182`) carries `loads/shows/symbols/background/palette` and **no version stamp**. A runtime fed an artifact compiled by a mismatched toolchain (cached style, an `import "mapbox-style"` path, a future persisted-scene feature) **silently misparses** instead of failing fast. There is no handshake to reject on.

### C5 — The only "parity" test does **not span the seam** — MEDIUM (false coverage) — FACT/INFERENCE
`compiler/src/codegen/node-to-wgsl.test.ts` validates the *compiler's own* IR→WGSL string emit. It is a good within-compiler oracle but it does **not** validate that the runtime's `Node`/`RuntimeExpr` interpretation matches the compiler AST, nor that the `as unknown as` cast (C3) is shape-safe. The comment at `renderer.ts:91` literally pins the seam's safety on this test — but the test is on the *wrong side* of the boundary. (INFERENCE: a compiler AST change that keeps `nodeToWgslString` output valid but changes node *shape* would pass this test and still break the runtime walk.)

### What is genuinely good here (one line each, with evidence)
- **A correct contract test exists — at the wrong boundary.** `blueprint/src/__tests__/contract.test.ts` is a real consumer-driven contract test (keeps exact codegen field keys; round-trips the starter graph through the real compiler) — the exact pattern compiler↔runtime needs and lacks. FACT.
- **The producer type is real and classified.** `DataExpr.ast: parser/ast.Expr` + optional `classification` (`render-node.ts:658-661`) — the compiler is not stringly-typed internally; only the *crossing* is. FACT.
- **`ShaderVariant` drift was already solved the right way.** `renderer-types.ts:16` aliases `ShaderVariantInfo = import('@xgis/compiler').ShaderVariant` to *"remove the drift surface entirely."* So the team knows the shared-type fix; it just wasn't applied to `ShowCommand`. FACT — and it makes C1 less forgivable, not more.

---

## PART 2 — Error handling & observability gaps

### E1 — Device loss is detected, then the map **permanently dies** — CRITICAL — FACT
`gpu.ts:214-223`: `device.lost.then(info => { ctx.deviceLost = true; … ctx.onDeviceLost?.(info) })`. That is the **entire** loss handler — it sets a flag and fires a callback. `render-loop.ts:128`: `if (this.host.ctx.deviceLost) return` — the loop halts with **no reschedule**.

Crucially, `requestAdapter()` / `requestDevice()` / `context.configure()` are called **only once, at init** (`gpu.ts:140,177,195`); the resize path re-`configure`s but never re-requests a device (`gpu.ts:256`). So there is **no recovery path anywhere** — no fresh-adapter loop, no resource rebuild, no re-`configure` on a new device. Any transient fault (driver reset, tab-watchdog, GPU-process crash, eGPU unplug) is terminal; the embedding app must destroy and recreate the whole map. The WebGPU spec defines the exact recovery contract (re-request adapter→device, rebuild all resources, re-`configure` the canvas) and X-GIS implements none of it. (The `'destroyed'`-reason filter at `gpu.ts:219` is correct and the one good touch — intentional teardown stays silent.)

### E2 — **No `'error'` event** on the public map API — CRITICAL — FACT
`runtime/src/engine/layer.ts:437-441`:
```
export type XGISMapEventType =
  | 'load' | 'idle'
  | 'movestart' | 'move' | 'moveend'
  | 'zoomstart' | 'zoom' | 'zoomend'
```
No `'error'` / `'rendererror'`. The runtime allow-list `MAP_EVENT_TYPES` (`map.ts:114-116`) matches — eight event names, none of them an error. Device loss, validation errors, worker crashes, and OOM reach `console.error` / a test-only queue but **never surface as an observable event**. An embedding app has no declarative way to show a "render error — reload" UI or wire telemetry. The reference (`map.on('error')` in MapLibre/Mapbox) is the standard surface for exactly this; X-GIS has the registry machinery (`MapEventRegistry`, `layer.ts:485`) but no error channel plumbed into it.

`onDeviceLost` (`gpu.ts:221`) is a **one-shot constructor callback**, not an event — it must be registered before load and fires once, so it is not a substitute for an observable `'error'` stream.

### E3 — Swallowed validation-error rejections — HIGH (cheap) — INFERENCE (from the audit doc; not re-read this pass)
The error-device-loss audit cites `render-loop.ts:291-294` and `:542-544` doing `popErrorScope().then(…).catch(() => {})` — silently dropping rejected pops. (Marked INFERENCE: I verified the device-loss/event facts first-hand above; the `.catch(()=>{})` lines I am carrying from `docs/research/2026-06-audit-error-device-loss.md:22` rather than re-reading, because the structural findings E1/E2 are the load-bearing ones for this axis.) There is an in-flight task #2 "un-swallow validation-error rejections," which corroborates the gap is real and acknowledged.

### E4 — Unbounded `uncapturederror` queue in production — MEDIUM (leak) — FACT
`gpu.ts:234-239` pushes **every** uncaptured error into `ctx._validationErrors` with no cap and no production drain (tests drain it via `getValidationErrors`; production never does). A persistent per-frame validation error grows the array unboundedly and `console.error`s 60×/s with no dedup/rate-limit. Slow leak + log flood on a long session.

---

## PART 3 — Additional axes a 5-year / 3D-tiles / 4D-city goal makes CRITICAL (and are weak TODAY)

I evaluated the owner's candidate list against present evidence. Five axes are real, present gaps. Ranked by how hard they block the stated goal.

### AXIS α — **Build / packaging / release: the library literally cannot be `npm install`ed** — CRITICAL — FACT
This is the most damning and the most concrete. `runtime/package.json` *looks* publishable: no `private:true`, `license: MIT`, real `exports`/`module`/`types`/`files` (`runtime/package.json:1-19`). But it depends on the rest of the monorepo via unresolvable specs:
```
"@xgis/compiler": "workspace:*",   // runtime/package.json:32
"@xgis/shared":   "workspace:*",   // runtime/package.json:33
```
And **both of those are `private:true` with `main: "./src/index.ts"`** (raw TypeScript, no build output) — verified: `compiler/package.json` (`private:true`, `main: ./src/index.ts`), `shared/package.json` (same), `blueprint/package.json` (same). So:
1. `npm install @xgis/runtime` resolves a `workspace:*` spec the public registry cannot satisfy → **install fails outright**.
2. Even if the spec were pinned, `@xgis/compiler` ships **no built JS** (`main` points at `.ts`), so a consumer with a plain bundler can't load it.
3. The root is `private:true` (`package.json:3`) and `@xgis/shared` is a 2-file package (`shared/src/`: `ecef.ts` + `index.ts`) that the runtime hard-depends on but cannot pull from npm.

**Evidence it's a real present gap:** the publishable-looking `runtime/package.json` is a trap — it advertises shippability the dependency graph contradicts. For a *sellable library* this is a hard blocker, not a nicety. (Cross-ref: the ship-readiness memory already flags `private:true` → "npm-impossible" as blocker #1; this audit confirms the mechanism is the `workspace:*`→`private` dependency chain, not just the root flag.)

### AXIS β — **Plugin / extension architecture: absent; 3D-tiles/custom layers have no entry point** — HIGH — FACT
Grep for `registerLayer|addLayerType|registerPlugin|CustomLayer|registerSource|plugin|extension` across `runtime/src` returns **no registration API** — the hits are incidental (`extendBindGroupLayoutEntriesForCompute`, vite plugin config, `extension` in unrelated strings). There is no `map.addLayer(customLayerImpl)` / custom-source registration seam. Layer *types* are hard-wired into the compiler grammar + the VTR draw loop; a new geometry kind (3D-tiles / glTF / point-cloud) cannot be added without editing the god-files. The reference (MapLibre `CustomLayerInterface`, deck.gl layer model) is exactly the extensibility a 3D-tiles roadmap needs. **Present gap:** to add 3D-tiles today you fork the engine; there is no published extension surface. INFERENCE (scope): closing this requires the very evaluated-data↔draw seam that `2026-06-runtime-architecture-why-hard.md` §3 identifies as missing (Blender DRW / Frostbite render-graph) — so β and the structural axis are the same wound.

### AXIS γ — **Type-safety at module boundaries: erased exactly where it matters** — HIGH — FACT
Not "TS is off" — strictness is on and the *internal* types are good (`DataExpr.ast: Expr`). The gap is that safety is **discarded at every cross-package seam**: `{ ast: unknown }` ×7 in `renderer-types.ts` + ×2 in compiler `render-node.ts`, and `as unknown as` appears **354 times across 93 files** in `runtime/src` (many are test stubs, but the *load-bearing* two at `renderer.ts:97,101` sit on the hottest contract). `XGISMapEvent.target` is typed `unknown` to dodge an import cycle (`layer.ts:449-451`) — a module-boundary type hole driven by architecture, not laziness. **Present gap:** the seams that most need types (compiler→runtime expr, event target) are precisely the ones typed `unknown`. Over a 5-year horizon every AST/IR evolution rides through an unchecked cast.

### AXIS δ — **Determinism / reproducibility: wall-clock + perf-clock threaded through the eval path** — MEDIUM — INFERENCE (mechanism FACT)
`Date.now()/performance.now()/Math.random` occur **42 times across 18 files in `runtime/src/engine`**, including the render-critical path: `render-loop.ts` (3), `vector-tile-renderer.ts` (4), `map.ts` (3), `tile-decision.ts` (1), `passes/label-pass.ts` (1), `passes/points-pass.ts` (1), `controller.ts` (4). Time-driven labels and animations read the clock during *evaluation* (the `2026-06-runtime-architecture-why-hard.md` §1 grounding names the S16 time-driven label staleness bug as exactly this). **Why it's critical for 4D/testing:** a renderer whose evaluation depends on un-injected wall-clock cannot be deterministically replayed or golden-tested for a *time* axis — the same scene at the same logical timestamp can produce different frames, which is the test-oracle nightmare the why-hard doc §4 describes. **Present gap (INFERENCE):** there is no single injectable clock seam; the clock is read ad hoc at 18 sites. (FACT = the 42 call sites; INFERENCE = that this defeats time-axis reproducibility, since I did not trace every site to confirm none is already injected.)

### AXIS ε — **Coordinate/time rigor for 4D: spatial is strong, temporal is a styling afterthought** — MEDIUM — FACT/INFERENCE
Spatial rigor is genuinely good (FACT): `@xgis/shared` is a dedicated ECEF module (`shared/src/ecef.ts`), there's an EPSG input-reprojection path (`proj4` dep, `LoadCommand.crs`), and the projection table is a documented authority. But **time is modelled only as an animation/styling primitive**: `TimeStop<T>` (`compiler/src/ir/render-node.ts:592`) is a paint-interpolation stop, and `interpolateTime` lives in the renderer-helpers — there is **no temporal data dimension** (no `valid_time`/`epoch`/feature-time attribute carried through `ShowCommand` or the tile pipeline; grep for `valid_time|epoch|datetime` finds nothing in the data path). **Why it's critical for a 4D-city:** "4D" means features exist *over time intervals* (construction → demolition, sensor time-series), which requires a time coordinate on the *data*, not just a clock on the *animation*. **Present gap:** the codebase has a time *cursor* (animation clock) but no time *axis on features* — the 4th dimension is presentational, not a queryable coordinate. (INFERENCE on the absence: grep-negative across the data path; I did not exhaustively read every loader.)

### Axes I considered and DOWN-RANKED (honesty)
- **Threading/worker model scalability** — present and *reasonable*, not a top gap. Worker pools size sensibly: MVT pool `Math.max(2, Math.min(ceiling, hc-1))` with a mobile cap of 2 (`mvt-worker-pool.ts:113-126`); GeoJSON compile pool caps at 4 (`geojson-compile-pool.ts:120`); both have sync fallback when `new Worker()` throws, and crashed workers reject in-flight jobs. The *gap* is recovery (no auto-restart, per the error audit B5) and that worker failures don't reach an `'error'` event (folds into E2) — so it's a symptom of α/ε axes, not its own top-5 axis. FACT.
- **Public API stability + semver** — real but downstream of α: you cannot have a meaningful semver contract on a package that can't be installed. Version is `0.0.1` everywhere; no `'error'`/`'move'` event payload is frozen. It becomes a top axis *the moment* α is fixed. INFERENCE.

---

## TOP FIXES (ranked, contract+observability+axes merged)
1. **Make it installable (AXIS α).** Build `@xgis/compiler`/`@xgis/shared` to JS, drop `private:true` on what `runtime` needs, and replace `workspace:*` with publishable specs — or bundle them into `@xgis/runtime`'s dist. Until this lands, "sellable library" is fiction. CRITICAL, blocks everything downstream.
2. **Share the contract type (C1/C2).** One `ShowCommand`/`LoadCommand`/`SceneCommands` + the expr-AST type, both packages import — converting hand-sync drift into compile errors at every site. The team already did this for `ShaderVariant` (`renderer-types.ts:16`); apply the same move. Highest-leverage single change for the seam.
3. **Add a `map.on('error')` event (E2) + device-loss recovery (E1).** Plumb device-loss/OOM/worker/validation failures into a typed `'error'` event; implement the spec recovery loop (fresh adapter→device→rebuild→`configure`). Unlocks telemetry and a "reconnecting" UX; today a driver hiccup is terminal.
4. **Validate the AST + stamp a version at ingestion (C3/C4).** A schema `.parse()` where the `as unknown as` cast lives (`renderer.ts:97,101`) turns silent runtime corruption into fail-fast; a `schemaVersion` on `SceneCommands` rejects mismatched compilers.
5. **Inject one clock + add a feature time axis (δ/ε).** A single injectable time source makes the time dimension reproducible/testable; a `valid_time`-style feature coordinate is the prerequisite for any real 4D-city query, not just animation.

---

## Evidence ledger (file:line, all first-hand unless marked)
- Duplicated contract types: `compiler/src/ir/emit-commands.ts:19,41,182` vs `runtime/src/engine/render/renderer-types.ts:52` + `runtime/src/engine/interpreter.ts:49,77`; sync-by-hand comments `renderer-types.ts:59`, `interpreter.ts:58`, divergent-by-design `interpreter.ts:67-74`.
- Untyped/double-cast expr seam: `renderer-types.ts:114,127,161,162,163,176,182` (`{ast:unknown}` ×7); `renderer.ts:90-93,97,101` (`as unknown as RuntimeExpr`); producer type intact `compiler/src/ir/render-node.ts:658-661`, boxed-to-unknown `compiler/src/ir/lower.ts:671..913,1676-1677` and `render-node.ts:408`.
- No version field: grep `schemaVersion|compilerVersion|contractVersion|irVersion|formatVersion` → zero in contract/`shared/`.
- Good-pattern-wrong-boundary: `blueprint/src/__tests__/contract.test.ts`; `ShaderVariantInfo` alias `renderer-types.ts:16`.
- Device loss no recovery: `gpu.ts:214-223` (detect+flag only), `render-loop.ts:128` (halt), single-shot device init `gpu.ts:140,177,195,256`.
- No `'error'` event: `layer.ts:437-441` (event union), `map.ts:114-116` (allow-list), registry exists `layer.ts:485`.
- Unbounded error queue: `gpu.ts:234-239`.
- Packaging un-installable: `runtime/package.json:32-33` (`workspace:*` deps), `compiler/package.json`/`shared/package.json`/`blueprint/package.json` (`private:true` + `main: ./src/index.ts`), root `package.json:3` (`private:true`); `@xgis/shared` = `shared/src/{ecef.ts,index.ts}`.
- No plugin API: grep `registerLayer|addLayerType|registerPlugin|CustomLayer|registerSource` → no registration surface in `runtime/src`.
- Type erasure at seams: `as unknown as` ×354 / 93 files in `runtime/src`; `XGISMapEvent.target: unknown` `layer.ts:449-451`.
- Determinism: `Date.now()/performance.now()/Math.random` ×42 / 18 files in `runtime/src/engine` (incl. `render-loop.ts`, `vector-tile-renderer.ts`, `tile-decision.ts`, `passes/label-pass.ts`).
- Time/4D: `TimeStop<T>` `compiler/src/ir/render-node.ts:592` (paint-only); no `valid_time/epoch/datetime` in data path.
- Worker model (down-ranked, FACT): `mvt-worker-pool.ts:113-126`, `geojson-compile-pool.ts:120`.
- Carried (INFERENCE, not re-read): swallowed `.catch(()=>{})` at `render-loop.ts:291-294,542-544` from `docs/research/2026-06-audit-error-device-loss.md:22`.
