# The portable kernel tier (#1812) — design

Owner-approved direction (2026-08-18): one `@compute` authoring surface for both
backends — WebGPU runs it natively, WebGL2 runs it as the existing fragment-GPGPU
lowering — promoted from compiler-private machinery to a **declared, validated tier**.
Design and audit by the session lead; implementation delegated per this spec.

## The one-sentence contract

A compute entry declared `portable: true` is guaranteed to emit on BOTH backends —
native `@compute` on WGSL (zero byte change), the `lowerComputeToFragment` pass on
GLSL with **no emit-site option** — and any construct outside the gather-only shape
fails validation at EVERY emit, on both writers, with a coded remedy.

## Why a declaration (superseding the recorded `emulateCompute` opt-in reason)

`GlslEmitOptions.emulateCompute`'s doc records why auto-lowering was rejected: the
rewrite changes the HOST contract (draw vs dispatch), so it must never be a silent
platform default. The declaration answers that objection rather than ignoring it:
the choice moves from the emit call site (a flag flipped without the kernel author's
knowledge) to the authoring site (where the kernel's shape is decided), and the RHI
layer that owns the host contract already speaks it (`rhi-webgl2/src/compute-webgl2.ts`
dispatches compute as a fullscreen draw into an R32UI target). `emulateCompute` stays
as a deprecated synonym for undeclared kernels; the superseding rationale goes into
its doc comment.

## Tier v1 shape (= exactly what `lowerComputeToFragment` supports today, formalized)

- ONE `@compute` entry, declared `portable: true`.
- `global_invocation_id` used only as `.x` (1-D linear index).
- Exactly ONE `read_write` storage binding, element **u32** (the lowering hardcodes
  the R32UI draw buffer, `glsl.ts` `ret: u32T`); exactly ONE write to it, at index
  `gid.x` (scatter → violation).
- At least one `uniform` binding of type `vec4<u32>` — the DISPATCH uniform
  (`.x` = invocation count, `.y` = output-grid width W_out; the lowering reads the
  FIRST uniform binding). Document the field contract; v1 keeps the first-uniform
  convention.
- NO `raw` statements in the entry's call-graph closure (a per-target raw contradicts
  the portability claim, and the analyzer cannot see through it).
- Barriers / workgroup memory / atomics are not authorable in the DSL today — the
  analyzer need not check for them; when they become authorable they join the
  violation list (note in the analyzer header, per the assertion-carries-information
  rule: no vacuous checks).

## Implementation pieces

### A. Core (Opus) — declaration, analyzer, rule, auto-path, reflect

1. **Declaration** — `core/ir/builder.ts` `FnOpts` gains
   `portable?: boolean` (TSDoc: compute-only; the tier contract in one paragraph,
   link this doc + #1812). `fn()` throws `dslError('SD0110', …)` when
   `portable` is set without `stage: 'compute'` (author-run guard — the two-layer
   pattern's runtime half). `core/ir/nodes.ts` `FuncDecl` gains structured
   `readonly portable?: boolean` (#740 R3: no attrs spelling — it is not a WGSL
   attribute, so the WGSL writer's bytes cannot change).
2. **Analyzer** — new `core/passes/portable-kernel.ts`:
   `analyzePortableKernel(m: ModuleDecl, entry: FuncDecl)` returning
   `{ ok: true; gid: ParamDecl; outBinding: BindingDecl; dispatchUniform: BindingDecl }`
   or `{ ok: false; violations: string[] }` (each violation a complete
   detail+remedy sentence). SINGLE AUTHORITY for the shape:
   `backends/glsl.ts` `lowerComputeToFragment` REUSES it for its own checks
   (replace the ad-hoc `UnsupportedFeatureError`s for shape violations with a call
   to the analyzer when the entry is portable-declared; keep the existing throws as
   the backstop for the undeclared/`emulateCompute` path so that path's messages do
   not change — its M2a pins stay byte-stable).
3. **Lint rule** — new `core/passes/lint/rules/portable-kernel.ts`, id
   `portable-kernel`, severity error, registered in `RULES` **and** `CORE_RULES`
   (`rules/index.ts`): for every `portable` compute entry, report each analyzer
   violation as `SD0111` with the detail text. CORE registration is what makes the
   diagnostics symmetric — `validate()` runs at every emit on BOTH writers.
4. **Codes** — `diagnostics/codes.ts`:
   - `SD0110` "portable declared on a non-compute entry", hint: "portable is the
     compute-tier declaration — it needs stage: 'compute'".
   - `SD0111` "portable kernel outside the gather-only tier", hint: "the portable
     tier is out[gid.x] = f(reads): 1-D gid, one u32 storage output written once at
     the invocation index, a vec4<u32> dispatch uniform, no raw statements —
     restructure or drop `portable` to keep the kernel WebGPU-only".
5. **GLSL auto-path** — `backends/glsl.ts` `lowerForGlsl`: when the module has a
   compute entry AND that entry is `portable`, run the compute lowering with no
   option. `emulateCompute` keeps working (same code path; mark deprecated in its
   TSDoc with the supersession note above). The non-portable, non-flag path keeps
   today's fail-closed `assertCaps` 'compute' diagnosis untouched (M2a pins it).
   `emit-identity.ts`: the stamp's `emulateCompute` marker must reflect "the
   lowering ran" — derive it from (option || portable-entry) so identity stays
   truthful on the new path.
6. **reflect()** — `core/reflect.ts` `EntryInfo` gains
   `readonly portable?: true` (present only when declared; TSDoc: the host-contract
   signal — on a backend without compute this module emits as fragment-GPGPU and is
   dispatched as a draw; see rhi-webgl2/compute-webgl2.ts).

### B. Verification (Opus) — fail-before corpus + parity pins + GPU gate

Every negative test is written fail-before (construct → red for the right reason →
green after A):

1. `SD0110`: `fn(…, { stage: 'vertex', portable: true })` throws at build.
2. `SD0111` per violation, each from BOTH `emitModule` and `emitGlslModule`
   (the symmetry pin): gid `.y`/whole-vec use; scatter write (`out[0] = …`);
   two writes; zero writes; output element f32; no read_write binding; missing /
   non-`vec4<u32>` dispatch uniform; a `raw` stmt in the entry body.
3. Byte pins: (a) a portable kernel's WGSL === the same kernel without the flag
   (declaration adds zero bytes); (b) the GLSL auto-path bytes === the
   `emulateCompute: true` bytes for the same module (the M2a fixture, declared
   portable).
4. M2b extension: the oracle differential fixture declared portable, run through
   the auto path — identical results.
5. reflect: `entries[…].portable === true` for a declared kernel; absent otherwise.
6. GPU gate: extend `playground/e2e/_compute-parity.ts` — emit the fragment shader
   through the PORTABLE path (no option) alongside the flag path, assert the two
   sources are byte-identical, and keep the existing execution parity on the
   portable-path source. (Multi-row H_out>1 GPU coverage is a recorded follow-up,
   not v1 — the recon found it CPU-only today; do not silently claim it.)

### C. Consumers & docs (Sonnet)

1. `compiler/src/codegen/compute-gen.ts`: add `portable: true` to the kernel
   `fn(…, { stage: 'compute', workgroupSize: … })` opts (the ~line 461 site) —
   compute-gen's kernels now pass the tier gate at every emit. If ANY compute-gen
   kernel violates the tier, do NOT loosen the analyzer: report it back verbatim.
2. `AUTHORING.md`: new subsection under §10 (capabilities) —
   "### Compute on WebGL2 — the portable kernel tier (#1812)": the contract, the
   dispatch-uniform field table (x=count, y=W_out), the host contract (draw vs
   dispatch, absorbed by rhi-webgl2), what is NOT in the tier and the remedy
   (multi-pass restructuring), and the `emulateCompute` deprecation note.
3. `docs/plans/2026-08-18-portable-kernel-tier.md` (this file) stays as the design
   record; update its "Landed" section at the end when the pieces merge.

## Ruled out (carried from #1812 — do not re-propose without new facts)

- Auto-decomposing barrier kernels into multi-pass (silent perf/precision changes;
  no current need). Transform-feedback as a second GPGPU vehicle (two-authorities
  drift). Inferring the tier instead of declaring it (silent tier drift when a
  kernel gains a non-portable construct).

## Landed

- **A. Core** — `portable?: boolean` on `FnOpts` (`core/ir/builder.ts`, SD0110 guard) and
  structured `FuncDecl.portable` (`core/ir/nodes.ts`, no attrs spelling); analyzer
  `analyzePortableKernel` (`core/passes/portable-kernel.ts`) as the single authority for the
  gather-only shape, reused by `backends/glsl.ts` `lowerComputeToFragment` for portable
  entries; lint rule `portable-kernel` (SD0111) registered in `RULES` and `CORE_RULES`
  (`core/passes/lint/rules/index.ts`); GLSL auto-path as an OPTION NORMALIZATION
  (`withPortableLowering` at the three GLSL emit entry points, not inside `lowerForGlsl` as
  spec'd — the emit reads the flag in two halves, IR chain + `assembleGlsl`'s bare `u_count`
  spelling, so normalizing is what makes auto-path bytes ≡ flag bytes by construction);
  `emit-identity.ts`'s `emulateCompute` stamp derived from `(option || portable-entry)` via an
  optional third `ModuleDecl` parameter; `reflect()`'s `EntryInfo.portable`
  (`core/reflect.ts`). Diagnostics `SD0110` / `SD0111` in `core/diagnostics/codes.ts`. Two
  load-bearing fixes surfaced during implementation: `lowerComputeToFragment` now carries the
  STRUCTURED stage across the rewrite (`stage: 'fragment'`, `workgroupSize`/`portable`
  cleared) — the old `...entry` spread left `stage: 'compute'` behind the `@fragment` attr,
  which `stageOf` reads first, so every structured-stage (fn-authored) kernel failed to
  assemble; and the fn HANDLE mirrors `portable` (builder.ts) with `isPortableComputeEntry`
  reading `stageOf(f)`, without which `module()` assembly silently dropped the declaration on
  the only path that can author it.
- **C. Consumers & docs** — `compiler/src/codegen/compute-gen.ts`'s single shared
  `buildComputeKernelModule` factory (used by all three kernel emitters —
  `emitInterpolateComputeKernel`, `emitMatchComputeKernel`, `emitTernaryComputeKernel`) now
  declares its one `fn()` compute entry `portable: true`; all three kernels pass the tier gate
  at every emit (single u32 `read_write` output written once at `gid.x`, `vec4<u32>` dispatch
  uniform, no `raw`). `AUTHORING.md` §10 gained "Compute on WebGL2 — the portable kernel tier
  (#1812)" documenting the contract, the dispatch-uniform fields, the host contract (absorbed
  by `rhi-webgl2/src/compute-webgl2.ts`), what falls outside the tier, and the `emulateCompute`
  deprecation note.
- **B. Verification** — fail-before corpus `core/passes/portable-kernel.test.ts` (22 tests:
  SD0110 at authoring, 11 SD0111 violation cases each asserted from BOTH writers,
  every-violation aggregation, WGSL zero-byte pin, GLSL auto ≡ flag byte pin, reflect signal,
  and the fn()-authored `module()`-assembly block that caught the dropped-declaration defect);
  M2b oracle arm on the portable-declared fixture (`glsl-compute-oracle.test.ts`); GPU gate
  `playground/e2e/_compute-parity.ts` now emits the fragment shader through the PORTABLE path,
  pins it byte-identical to the `emulateCompute` emit, and runs the execution parity on the
  portable-path source. Class asymmetry is pinned as-built: WGSL fails via `validate()`
  (ValidationError aggregating `[SD0111]` lines), GLSL fails earlier in
  `lowerComputeToFragment` (ShaderDslError, `code === 'SD0111'`) — the CODE and violation
  SENTENCE are the symmetric halves, both from `analyzePortableKernel`. `emitIdentity`'s
  module-derived marker got a durable test in `emit-identity.test.ts` (session-lead audit
  addition). Multi-row H_out>1 GPU coverage stays a recorded follow-up, not claimed here.
- **Follow-up (#1823)** — `rhi-webgl2/src/compute-webgl2.ts` now emits with NO option: the
  kernel's `portable` declaration routes the lowering, and an UNDECLARED compute kernel
  fail-closes at emit before the device is touched (fail-first pin:
  `compute-webgl2-portable-contract.test.ts`). The "multi-row GPU coverage is CPU-only"
  premise was stale — `_compute-dispatch-parity` already ran N=4100 (W=2048, H_out=3,
  over-grid discard) through the production dispatcher on real WebGL2; the flip makes that
  lane judge the PORTABLE-path source, which closes the recorded follow-up. 2-D `gid.xy`
  admission and the output-format matrix are deferred WITH reasons in #1823 (WebGPU
  dispatches 1-D so `gid.y ≡ 0` there — admitting `.y` without a 2-D host dispatch
  contract creates the exact divergence the tier prevents; no consumer needs a non-u32
  output).
