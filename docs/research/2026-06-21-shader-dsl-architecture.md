# `@xgis/shader-dsl` — architecture design (conceptual model · module structure · plugin & override contracts)

Design-first. No code until this is agreed. Companion to the redesign plan
(`2026-06-21-shader-dsl-backend-agnostic-redesign.md`) and the DX/PoC
(`2026-06-21-shader-dsl-dx-before-after.md`, `prototypes/shader-dsl-backend-agnostic-poc.ts`).

## 1. Design goals & principles

1. **Single source, many targets.** One authored graph → WGSL, GLSL ES 3.00 (later SPIR-V/MSL),
   plus a CPU oracle. No parallel hand-written shaders.
2. **The IR is target-neutral.** Zero target lexemes (`vec3<f32>`, `@group`, `textureSample`) live
   in the IR. All spelling lives in writers.
3. **Open/closed.** Adding a target is _one new file_ implementing a contract — **zero edits to the
   core or to other backends**. This is the load-bearing principle; everything below serves it.
4. **Capability honesty.** A target declares what it supports; emitting an unsupported feature is a
   typed compile-time error, never silent mis-emit.
5. **Oracle-verified.** Every pure function is independently evaluable on a CPU f64 oracle →
   differential ground truth (WGSL/GPU ↔ GLSL ↔ CPU agree).
6. **Authoring is backend-agnostic.** Shader graphs never name a backend. All per-backend variation
   is confined to the lowering/emit layer.

## 2. Conceptual model

Five entity groups; one acyclic data flow.

```
 ┌────────────┐   author    ┌──────────────┐  neutral passes  ┌──────────────┐
 │ Authoring  │ ──────────► │  Neutral IR  │ ───────────────► │  Lowered IR  │
 │ (Node/fn)  │             │  (Module)    │  (match-lower,    │ (per target) │
 └────────────┘             └──────┬───────┘   const-fold)     └──────┬───────┘
                                   │                                   │ backend passes
                  side consumer    │                                   │ (io-flatten,
                            ┌──────▼───────┐                    ┌──────▼───────┐ sampler-fuse)
                            │  CPU Oracle  │                    │   Backend    │ emit
                            │ (f64 eval)   │                    │  (Writer)    │ ───────► String
                            └──────────────┘                    └──────────────┘
```

| Concept                 | What it is                                                                                                                      | Backend-aware?                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Type** (`ShaderType`) | abstract kind descriptor (scalar/vec/mat/tex/sampler/struct/array/void) + `canonicalKey` (spelling-free identity)               | no                                      |
| **Expr / Stmt / Decl**  | the IR nodes; intrinsics carry an `IntrinsicId` enum, IO carries structured `IOSlot`, resources carry a logical `ResourceDecl`  | no                                      |
| **Module**              | a unit of emit: `funcs` + `entries` + `resources` + a declared `Requires` capability set                                        | no                                      |
| **Intrinsic**           | a known operation (`IntrinsicId`); the core owns its _semantics_ (arity, signature, CPU fold), each backend owns its _spelling_ | spelling: yes                           |
| **Pass**                | an IR→IR transform; _neutral_ (match→switch, const-fold) or _backend_ (struct-IO flatten, sampler fuse)                         | backend passes: yes                     |
| **Backend (Writer)**    | a plugin that spells types/intrinsics/IO/resources + declares `Capabilities` + contributes passes                               | **yes — the only place spelling lives** |
| **Oracle**              | the CPU f64 evaluator; a _consumer_ of the IR, not a render target                                                              | no (it is not a Backend)                |
| **LayoutPlan**          | the resolved byte layout + binding slots; the single source binding `writeBuffer` ↔ shader struct                               | produced per backend                    |

## 3. Module & folder structure

Strict acyclic import DAG, leaf → root (a module may import only from lower layers).

```
shader-dsl/src/
  index.ts                     ── public barrel (authoring + compile + backends + oracle)
  compile.ts                   ── compile(module, backend) → { code, layout, caps }   [root]

  core/
    types/
      types.ts                 ── ShaderType, canonicalKey (NEUTRAL identity), kind predicates
      keys.ts                  ── KeyOf/ElemKey (neutral tokens) + Vec4f/F32/… authoring aliases
    ir/
      nodes.ts                 ── Expr/Stmt + Decls (FuncDecl, EntryDecl, ResourceDecl, ConstDecl)
      node.ts                  ── Node<K> fluent authoring (typed, backend-agnostic)
      builder.ts               ── Builder + fn/entry/compute/module
      index.ts                 ── IR barrel (types ← keys ← nodes ← node ← builder)
    intrinsics.ts              ── IntrinsicId + IntrinsicSpec{ arity, signature, cpu } (SEMANTICS only)
    capabilities.ts            ── Capability + Capabilities{ has, covers, missing }
    backend.ts                 ── Backend interface (the plugin contract) + StringWriterBase
    layout.ts                  ── ResourceKind, LayoutPlan, ResourceLowering contract
    passes/
      pass.ts                  ── Pass interface (Module → Module) + the runner
      match-lower.ts           ── neutral: matchExpr → var+switch   (was backends/wgsl-lower.ts)
      const-fold.ts            ── neutral
      io-flatten.ts            ── backend(GLSL): struct-IO → in/out globals
      sampler-fuse.ts          ── backend(GLSL): texture+sampler → combined sampler
    oracle.ts                  ── CPU f64 evaluator (was backends/cpu.ts; NOT a Backend)
    schema.ts                  ── struct() helper (feeds layout)

  backends/                    ── PLUGINS — each file self-contained, zero cross-edits
    wgsl.ts                    ── WgslBackend implements Backend (byte-identical to today)
    glsl-es300.ts              ── GlslEs300Backend implements Backend  (NEW)
    (later) spirv.ts, msl.ts   ── drop-in, no core change

  shaders/                     ── the graphs (UNCHANGED authoring; backend-agnostic)
```

**Why the split matters:** today `core/backends/` holds a writer + a neutral pass + the oracle —
the folder name lies. The redesign separates _writer_ (`backends/`), _pass_ (`core/passes/`), and
_oracle_ (`core/oracle.ts`), so the structure states the architecture.

## 4. The Backend plugin contract

A target is an object implementing `Backend`. The emit driver is generic; it calls into the plugin
for every target-specific decision. There is **no global registry** — `compile(module, backend)`
takes the plugin explicitly (a registry is optional, for tooling only).

```ts
interface Backend {
  readonly id: string // 'wgsl' | 'glsl-es300' | …
  readonly caps: Capabilities // what this target supports (gate)

  // ── spelling (the override surface) ──
  typeName(t: ShaderType): string // vec3<f32> | vec3
  literal(v: number | boolean, t: ShaderType): string // 1u | 1
  intrinsic(id: IntrinsicId, args: string[], types: ShaderType[]): string // select() | ternary
  binop(op: BinOp, a: string, b: string): string // default in StringWriterBase

  // ── structure lowering ──
  lowerEntry(e: EntryDecl, m: ModuleCtx): string // @vertex+struct | main()+gl_*
  lowerResource(d: ResourceDecl, slot: SlotAssignment): string // @group/@binding | std140 UBO
  finalizeModule(parts: ModuleParts): string // GLSL: '#version 300 es' header

  // ── pipeline contribution ──
  passes(): readonly Pass[] // backend-required IR transforms (GLSL: io-flatten, …)
}
```

**`StringWriterBase`** provides the target-independent string scaffolding (statement emit, binop
parenthesisation, function signature shape) so a new backend overrides only what genuinely differs
(~6 methods), not the whole emitter.

**Required of every backend:** total `typeName`/`literal` over all `ShaderType`; an `intrinsic`
spelling (or throw `UnsupportedFeature`) for every `IntrinsicId` reachable given its `caps`; honest
`caps`. **Forbidden:** reading another backend's internals; mutating the IR outside its `passes()`.

## 5. Override & extension surfaces

Extension is **compositional**, never by forking the core. Five surfaces, each scoped:

1. **Type spelling** — override `Backend.typeName` / `literal`. (`StringWriterBase` has no default —
   spelling is inherently per-target.)
2. **Intrinsic spelling** — the core owns the **semantics** centrally (`IntrinsicSpec`: arity,
   signature for type-check, the `cpu` fold). Each backend owns the **spelling** in _its own file_
   via `Backend.intrinsic(id, …)`. Adding a backend adds a spelling table in that backend; it never
   edits a central registry. A backend without a spelling for an `id` reachable under its caps =
   compile error (caught by a coverage test). _This central-semantics / per-backend-spelling split is
   the key plugin decision._
3. **IO/entry lowering** — override `Backend.lowerEntry`. WGSL emits a struct + `@location`; GLSL
   runs `io-flatten` (its own pass) then emits `in/out` globals + `main()`.
4. **Resource lowering** — override `Backend.lowerResource` + supply a `ResourceLowering` that yields
   a `LayoutPlan`. `caps.supports(kind)` lets a backend declare a resource kind unsupported → the
   driver raises `UnsupportedFeature` (the renderer can then route that shader to WGSL).
5. **Passes** — `Backend.passes()` contributes backend-specific IR transforms; the driver runs
   _neutral passes → backend passes → emit_, so a backend customises the IR _before_ it sees it
   without touching neutral code.

**Authoring is NOT an override surface.** Shader graphs are written once, target-free. The single
escape hatch is a `raw` Stmt flagged `backendOnly: 'wgsl'` — **fail-closed**: any other backend
emitting it throws. (Goal: zero `raw` after the compiler returns `Stmt[]` for the match-chain.)

## 6. The lowering pipeline

`compile(module, backend)` is a fixed pipeline; backends inject only at the marked points.

```
validate(module.requires ⊆ backend.caps)         // capability gate — fail fast, typed error
  → run NEUTRAL passes      [match-lower, const-fold]            (shared, ordered, idempotent)
  → run backend.passes()    [e.g. io-flatten, sampler-fuse]     (GLSL only)
  → assignLayout(resources) → LayoutPlan          (backend.lowerResource)
  → emit funcs/entries      (backend.typeName/intrinsic/lowerEntry)
  → backend.finalizeModule  → { code, layout, caps }
```

Passes are `Module → Module`, declared idempotent and order-independent within a phase where
possible (mirrors Tint). The neutral phase output is what the CPU oracle also consumes.

## 7. Adding a new target (the open/closed proof)

To add WebGL2/GLSL — or later SPIR-V/MSL — you write **one file** `backends/<id>.ts`:

1. `class XBackend extends StringWriterBase implements Backend` with `typeName`/`literal`/`intrinsic`
   spelling + `lowerEntry`/`lowerResource` + `caps` + `passes()`.
2. (optional) backend-specific passes under `core/passes/`.
   No edit to `core/ir`, `core/intrinsics` (semantics), the shaders, or other backends. A coverage test
   asserts the new backend spells every `IntrinsicId` reachable under its `caps`. Done.

## 8. Invariants & contracts (the guard rails)

- **IR purity:** `grep` for `vec.<f32>`, `@group`, `@vertex`, `textureSample`, `bitcast<` under
  `core/ir`, `core/types`, `shaders/` must be **empty** (a CI lint). Spelling lives only in `backends/`.
- **WGSL byte-identity:** through the de-leak phases, `WgslBackend` reproduces today's exact output —
  pinned by `polygon-variant-diff` snapshot + the executed-WGSL parity spec.
- **Capability soundness:** `compile()` never emits a feature outside `backend.caps`; proven by a test
  that compiles every shader against every backend and asserts either valid output or
  `UnsupportedFeature`.
- **Oracle agreement:** for every pure fn, `WGSL-on-GPU == GLSL-on-WebGL2 == oracle` within the f32/
  truncated-const tolerance (the existing `_shader-math-parity` discipline).
- **Layout single-source:** VTR reads offsets/slots from `LayoutPlan`, never from hand-kept constants
  (kills the repo's #1 drift bug class; the 256-byte `Uniforms` becomes generated).

## 9. Anti-patterns (forbidden)

- A backend `import`ing another backend. → share via `StringWriterBase` / `core`.
- A target lexeme in `core/ir` or a shader graph. → it belongs in a `Backend` method.
- A central `if (backend.id === 'glsl')` branch. → that is the override surface; put it in the
  backend.
- A live (non-`backendOnly`) `raw` Stmt. → fail-closed.
- Hand-synced buffer offsets in the renderer. → `LayoutPlan`.

---

**Decision points for sign-off (before any code):**

- (a) **intrinsic model:** central semantics + per-backend spelling (§5.2) — agreed?
- (b) **backend selection:** explicit `compile(m, backend)` (no global registry) — agreed?
- (c) **`raw` policy:** fail-closed `backendOnly`, target zero — agreed?
- (d) **folder split:** writer / pass / oracle separated as §3 — agreed?

Once (a)–(d) are signed off, S0 (the pure relocation: `wgsl-lower→passes/`, `cpu→oracle`) is the
first, zero-risk implementation step.
