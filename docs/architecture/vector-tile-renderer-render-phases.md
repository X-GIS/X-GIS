# `VectorTileRenderer.render()` — the phase spine

Design record for #2508. Written by the architect pass before any code moved, amended by
the author pass with what execution taught; both are in this file so the next reader does
not re-derive either. Owner ground truth this serves: a 5,000-line renderer whose one
2,000-line method could only be read by scrolling was the reason the file kept growing —
"구조화된게 없으니까 커지는거 아닌가요".

## What was measured, and what it decided

`map/src/render/vector-tile-renderer.ts` was 5,588 lines with 74 class members. Two members
were half the file: `render()` (1,964 lines, 35 %) and `renderTileKeys()` (800). Inside
`render()`: two section comments, 31 top-level control statements, nesting to ten levels.

The LOC ratchet did not prevent this: the file was baselined at 4,334 on 2026-07-11 and
grew +29 % in two months, one justified raise at a time. A check that forbids growth
cannot force retirement (the same defect #2474 found in the backend-identity ratchet).

The decisive finding: **`render()` is long but not tangled.** A free-variable analysis of
each candidate range on the TypeScript AST (scope-resolved — not a regex) showed that of
40 top-level declarations, the number crossing forward into later code falls monotonically
along the method, and that its last ~1,000 lines are **pure consumers**: they declare
nothing a later line reads.

| phase                   | lines (before) | declares | of those, read later          |
| ----------------------- | -------------- | -------- | ----------------------------- |
| 0 · guards + unwrap     | 27             | 2        | 1 (`pass`)                    |
| 1 · layer slot          | 92             | 3        | 2                             |
| 2 · tile selection      | 88             | 16       | 16                            |
| 3 · paint → uniforms    | 409            | 13       | 2 (+25 `this.*` paint fields) |
| 4 · tile classification | 268            | 11       | 8                             |
| 5 · fetch + prefetch    | 154            | 1        | **0**                         |
| 6 · drape routing       | 97             | 1        | **0**                         |
| 7 · primary draw        | 326            | 0        | **0**                         |
| 8 · fallback draw       | 279            | 0        | **0**                         |
| 9 · prefetch tiers      | 86             | 0        | **0**                         |
| 10 · epilogue           | 38             | 0        | **0**                         |

The data flow was already layered; it had no names. Naming it is the whole change.

## The shape that landed

`render()` is a 40-line spine (25 of them the argument record), then eleven private
methods in phase order:

```ts
const args: RenderArgs = { rhiPass, camera, … }          // the 22 parameters, once
const pass = this.guardAndUnwrapPass(args); if (!pass) return
const slot = this.resolveLayerSlot(args)                  // LayerSlot
const sel = this.selectVisibleTiles(args, slot)           // TileSelection
const paint = this.resolvePaintUniforms(args, sel)        // PaintSlots
const cls = this.classifyTiles(slot, sel)                 // TileClassification
const ctx: RenderFrameState = { pass, ...slot, ...sel, ...paint, ...cls }
this.requestAndPrefetch(args, ctx)
this.resolveDrapeRouting(args, ctx)
this.drawPrimary(args, ctx)
this.drawFallback(args, ctx)
this.prefetchTiers(args, ctx)
this.trackStableSetAndPoints(args, ctx)
```

Two records carry everything that used to be scope:

- **`RenderArgs`** (`vector-tile-renderer-types.ts`) — `render()`'s parameter list as one
  value. The parameter docs on `render()` remain the contract; the record mirrors them.
- **`RenderFrameState`** (declared next to `render()`) — `{ pass } & LayerSlot &
TileSelection & PaintSlots & TileClassification`. Each producer phase returns its record;
  the record types (with the field docs) live in the types file. The field set is
  **measured**, not designed: a field exists because a later phase reads it.

Phase contracts, as the method docs state them:

| #   | method                    | reads      | produces / effect                                                                      |
| --- | ------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| 0   | `guardAndUnwrapPass`      | args       | the unwrapped pass, or `null` = this call draws nothing                                |
| 1   | `resolveLayerSlot`        | args       | `LayerSlot` — slice key + resident-tile cache; per-frame bookkeeping                   |
| 2   | `selectVisibleTiles`      | args, slot | `TileSelection` — view, selector inputs, cached selection (16 fields)                  |
| 3   | `resolvePaintUniforms`    | args, sel  | `PaintSlots` — layer-slot offsets; every uniform written; the `current*` paint fields  |
| 4   | `classifyTiles`           | slot, sel  | `TileClassification` — one decision per visible tile, fallback pushes, keys to request |
| 5   | `requestAndPrefetch`      | args, ctx  | missing tiles requested, stale uploads dropped, priority installed                     |
| 6   | `resolveDrapeRouting`     | args, ctx  | the drape fields the draw phases read                                                  |
| 7   | `drawPrimary`             | args, ctx  | current-zoom tiles drawn (stencil write) across world copies                           |
| 8   | `drawFallback`            | args, ctx  | fallback ancestors drawn (stencil test); **re-sorts the fallback arrays into `ctx`**   |
| 9   | `prefetchTiers`           | args, ctx  | adjacent + zoom-direction prefetch                                                     |
| 10  | `trackStableSetAndPoints` | args, ctx  | stable set recorded (in the sorted order), tile points emitted                         |

Phase 8's write is the one frame-state mutation by a consumer. It is documented on the
method and on the three fields (the only non-`readonly` ones), and it fixed the extraction
order: the epilogue was extracted **before** the fallback draw so no in-`render()` reader of
the local array survived the writer.

The `this.*` fields that cross phases (the 25 paint fields written in phase 3, the drape
fields written in phase 6) stay fields: they are read by the draw phases through `this`
exactly as before, and `vtr-fallback-drape-draw.test.ts` pins the save / clear / restore
idiom around the fallback dispatch on the source text.

## Decisions the author pass had to take

**In place, with two records — not individual parameters, not a new file.** A verbatim
extraction with individual parameters costs ~+51 lines per phase (a 19-parameter
signature and a 19-argument call, prettier-wrapped) against a shrink-only ceiling. Moving
the phases to another file needs the 77 distinct private members the bodies touch to
become non-private on a class `@xgis/map` exports from its index, with no
`@internal` / `stripInternal` convention to hide them, and re-points ~15 source-text tests.
The records cost ~+10 lines per phase and put the frame's data flow in one named type.

**Bodies are AST-rewritten, not copied.** Every reference to a crossing local becomes
`ctx.x` (or `args.p`, `slot.x`, `sel.x`), resolved against scope so an inner binding of the
same name — arrow parameters, `for…of` variables — is untouched, and a shorthand property
`{ sliceLayer }` becomes `{ sliceLayer: ctx.sliceLayer }`. `tsc` proves every rewritten
name resolves; the frame hash proves the pixels; the decision counts prove the branches.

**Two ratchets pushed back on the record types, and the shape of that surprise generalises.** `RenderFrameState.pass` is the raw
`GPURenderPassEncoder` `render()` unwraps once; restating it in the types file grew the
#991 raw-WebGPU count of that file, and typing it through `typeof unwrapWebGpuPass` there
grew the backend-adapter count instead. Neither is a new GPU touch, but neither ratchet
can tell. `RenderFrameState` and the alias
`UnwrappedRenderPass = Extract<ReturnType<typeof unwrapWebGpuPass>, { setStencilReference(ref: number): void }>`
therefore live in the renderer, which already owns that import and that debt, and
`RenderArgs.bindGroupLayout` is typed through the map-side owner of layouts
(`NonNullable<ReturnType<BindGroupRegistry['baseLayout']>>`). Both ratchets stay flat, and
when #991 moves the pass to an RHI handle the alias follows without an edit.

The general lesson: a ratchet that counts identifiers **per file** measures where a type is
written, not what the code touches. Moving a declaration across a file boundary moves its
count — a refactor that only relocates existing debt can redden it, and the fix is to
declare the type in the file that already owns the seam, never to raise the baseline.

**Cost, stated.** The file is 5,588 → 5,789 lines (+3.6 %): the two records' literals, the
state alias and eleven doc + signature blocks. `render()` is 1,964 → 40. The types file
grows by the four producer records (+130). The LOC ceiling was re-measured on every
increment and its entry says why.

## Verification, per increment

A pure reshaping must not move a pixel, and the repo can assert that at the strongest rung
(CLAUDE.md §5): **byte-identical frames**, not a tolerance.

- `bun run build` (the typecheck authority) EXIT 0, then the 59 unit-test files that read
  the renderer's source (source-text pins follow the source: one regex now expects
  `ctx._inv`).
- A settle-until-idle probe — the `_bundle-replay-parity-gate` recipe: reduced motion,
  `?msaa=1&adaptive=0`, bearing-wiggle → `idle`, chrome-free clip capture, two consecutive
  identical sha256 — over seven fixtures: flat + globe `import_maplibre_mirror`, globe
  `minimal` direct and forced-drape, `dark` at the #2024 over-zoom camera flat and globe,
  `fixture_translucent_stroke`. Alongside the hash it records each source's
  `getLastDecisionCounts()` and drape flags, so a phase move that changed _which branch
  ran_ shows even where the pixels agree. The baseline shows `parent-fallback` decisions
  at idle in four fixtures — the fallback phase is exercised, not merely compiled.
- Hash + counts identical after increments 7, 8 (cumulative with 10), 9 (cumulative with
  5, 6) and P4 (cumulative with P0–P3). Each increment is its own commit for bisection.

## What this deliberately does not do

- ~~**Split the file** (#2537)~~ — **done.** The phases are named and their data flow is
  typed, so the move was mechanical; the blocker was that the bodies read 81 `this.*`
  members, **77 of them private**, on a class `@xgis/map` exports from its index, with no
  `@internal` + `stripInternal` convention to hide them again (0 of 488 tsconfigs). The
  owner chose `@internal` on 2026-09-06. See **What landed after this record** below — in
  particular that the option as #2537 worded it (adopt `stripInternal` **repo-wide**) would
  not have built.
- ~~**Touch `renderTileKeys()`** (800 lines)~~ — **done** (#2508 step 3). It is called from
  phases 7 and 8; reshaping it before its callers had names would have been done twice. It
  needed no visibility decision — it stays reachable either way.
- **Split phase 3** (409 lines, one long uniform-write block). Knowable only from inside
  it; the phase boundary makes it a local question now.

## Socratic critique, kept

**Does it couple anything new?** No. Every phase is a private member of the same class
reading the same fields; the records are two types. Nothing for the architecture
invariants or the dependency-direction ratchet to see.

**Are the records speculative?** No — their fields are the measured crossing set. If one
were unused the compiler would say so.

**What would have falsified the plan?** A frame hash that moved on an increment whose diff
is pure motion — a phase boundary cut through state outside the measured sets. The
back-to-front order for the consumers bounds the blast radius of such a move to one
increment; none moved.

## What landed after this record

This file is the design record for **step 1** — naming the phases in place. Steps 2 and 3
followed; the numbers below are what they measured, so nobody reads the tables above as
current state.

|                            | step 1 (#2573)       | step 2 (#2614)       | step 3                   |
| -------------------------- | -------------------- | -------------------- | ------------------------ |
| `vector-tile-renderer.ts`  | 5,588 → 5,873        | → **3,886**          | → **3,395**              |
| `render()` body            | 1,964 → 41           | 41                   | 41                       |
| `renderTileKeys()` body    | 798                  | 798                  | → **251**                |
| largest member in the file | `renderTileKeys` 798 | `renderTileKeys` 798 | **`renderFillsRhi` 297** |

Step 1 RAISED the LOC ceiling (+285, for two state literals and eleven doc + signature
blocks) and said so; steps 2 and 3 lowered it twice, to 42 % of where this record started.
**Nothing in the file is over ~300 lines now.**

**Where the code went.** Ten phases to `map/src/render/render-phases/` (phase 0,
`guardAndUnwrapPass`, stays a private method — it is the frame's concrete-backend seam, and
moving it _spread_ the `@xgis/rhi-webgpu` coupling to a second file rather than moving it).
`renderTileKeys()`'s three blocks to `map/src/render/tile-draw/`: the per-tile uniform pack,
the per-tile fill draw, and the deferred stroke pass.

**Three things the second and third steps taught, none visible from a read:**

1. **`private` → `@internal` NARROWS the published surface.** `tsc` emits a `private` member
   as a name-only slot; `stripInternal` removes it outright. 98 `private` name slots left
   `map/dist/index.d.ts` across the two steps (849 → 751) with declarations, exports and
   members unchanged at 463 / 50 / 2,625. But the flag cannot be repo-wide: `map/src/map.ts`
   reads an `@internal` member of the compiler _through `compiler/dist/index.d.ts`_, so it
   lives in `map/tsconfig.publish.json` only — the publish pass strips, the typecheck pass
   does not.
2. **A restated type is a spread; a derived one is free.** A per-file ratchet counts where a
   type is _written_, not what the code touches, so restating `GPURenderPassEncoder |
GPURenderBundleEncoder` in a new module's parameter list ADDS native tokens without
   removing any from the class. Deriving from the seam
   (`Parameters<VectorTileRenderer['renderTileKeys']>[1]`) costs none and follows the seam
   when it moves.
3. **The extraction states control flow a read leaves buried.** `renderTileKeys`'s fill
   block carried a bare `continue` that abandoned the rest of the tile's iteration; it
   cannot cross a function boundary, so the abort became a return value. Step 1 hit the same
   shape twice (phases 1 and 2 carry aborts, not only outputs).

**The source-text gates follow the code through one reader.** `map/src/render/render-path-source.ts`
returns the class plus every lifted module and normalises the parameter `vtr.` back to
`this.`, so the 13 gates that pin this path kept their assertions verbatim. One gate that
did NOT use it — the polygonU uniform-completeness gate — went red naming `light_dir_ecef`
as written by nobody the moment the per-tile light writes moved. That is the good outcome:
a gate keyed on presence rather than absence would have gone quietly green.

**Still open on #2508: step 4, the ratchet reshape** — the part that decides whether any of
this holds. The current form forbids growth but cannot force retirement, which is how this
file grew +29 % one justified raise at a time. Measured 2026-09-06: 38 baselined files,
**51,579 lines of ceiling in total**, every one of them above the 800-line `NEW_FILE_CAP`,
and the largest is no longer this file but `map/src/map.ts` at 5,547.
