---
name: debug-toolkit
description: >
  Localize a render/data divergence in X-GIS when the symptom is a wrong
  PIXEL or a wrong value many boundaries downstream of its cause — "the
  polygon outline draws offset from the fill", "the line is too thin", "this
  value is wrong but I can't see where it got corrupted", "which functions
  run, in order, in this path". X-GIS's dominant bug archetype is two SIBLING
  paths that must agree (fill vs outline, CPU vs GPU projection, polygon vs
  line shader) silently diverging — sub-pixel at native zoom, only visible
  once an over-zoom / pitch / projection axis amplifies it. This skill is the
  gdb-parity toolkit for that: dev-only cross-path asserts + watchpoints
  (CPU), GPU readback-parity, and visual bisect — applied in that order to
  turn "confirm the symptom" into "localize the cause at the violating line".
  Pairs with prove-or-refute (an INVARIANT becomes a live devAssert) and
  visual-artifact-bisect (the real-GPU visual layer).
---

# Debug toolkit — gdb-parity for the "two paths diverge silently" bug

## Why X-GIS debugging is hard (the axis that's actually blocked)

Following the trace is tedious-but-doable; the call stack is fine except at
async/worker boundaries. The wall is **input → output**, because:

1. The real output is **composited GPU pixels** — no breakpoint, no log, no
   intermediate inspection inside a WGSL shader.
2. The **CPU mirror ≠ GPU reality**; the bug lives where they diverge.
3. The defect is **sub-pixel until amplified** — `input→output` looks correct
   under the camera you tested, wrong only at an untested (camera × zoom ×
   projection × data) point.
4. **Nothing fails-fast at the violation site** — a wrong value flows CPU →
   worker → buffer → shader → pixel silently; by the time you SEE a pixel
   you're five boundaries downstream with no signal pointing back.

Observability dies at three boundaries: `CPU → Worker` (postMessage, async, no
shared stack), `Worker → GPU buffer` (writeBuffer — invisible without a
readback; a mock device validates nothing), `GPU buffer → shader → pixel` (no
introspection; the CPU mirror is the only proxy and it drifts).

## gdb (C) → X-GIS capability map

| gdb / C | X-GIS today | gap |
|---|---|---|
| breakpoint + step/next | Chrome DevTools (headed, JS only), not agent-scriptable | no scriptable step debugger |
| bt (backtrace) | `new Error().stack` / `console.trace()` | **have it** |
| print expr | `console.log` / dump-accessor | **have it** |
| assert / `#ifdef DEBUG` | `devAssert` (this skill) | build-strip wired |
| **watch var (watchpoint)** | `devWatch` (this skill) | emulated — see below |
| call hierarchy (outgoing) | LSP `document_symbols` ranges + read body; ast-grep if napi installed | no built-in ordered extractor |

`trace_timeline` is an **OMC agent-flow** trace (hooks/skills/agents), NOT a
code-execution tracer — useless for call order.

## The method — three layers, in order

Apply CPU first (cheapest, and it tells you whether you even need the GPU),
then GPU readback if the data was clean, then visual to say which path is right.

### 1. CPU cross-path — `runtime/src/dev/dev-assert.ts`

Dev-only, `import.meta.env.DEV`-gated (true under dev server + vitest, stripped
by esbuild in the production app build → zero cost). Read the gate at each call.

- `devAssert(cond, msg)` — C `assert()`. `msg` may be a thunk (only built on fire).
- `devAssertClose(a, b, eps, msg)` — **the workhorse.** Two scalars that MUST
  agree; reports the actual delta (a rounding bug vs a wrong-origin bug look
  different). NaN-safe.
- `devWatch(name, value, eps?, onChange?)` — **watchpoint.** First tick a named
  value moves beyond `eps`, fire (default: warn + captured stack). **Exhaustive
  over EXECUTION** — catches the divergence on whatever tile/frame/projection
  first triggers it, including the axis you never screenshotted. A screenshot
  sees one camera; `devWatch` sees every tile built.

Pattern — split DATA-cause from SHADER-cause: decode the SAME logical quantity
from both sibling paths back to a common frame and assert equality.

```ts
// fires ⇒ divergence is in the DATA (CPU); passes ⇒ it's in the SHADER (GPU)
devAssertClose(decodeFillVtx(fillBuf, i), decodeOutlineVtx(outBuf, j), 1e-9,
  () => `tile ${key}: fill/outline geo split`)
```

### 2. GPU readback-parity (data was clean → the shader disagrees)

Run the suspect shader math in a standalone COMPUTE pass, `mapAsync` it back,
compare to the CPU mirror / to the sibling shader. This is the existing
`_shader-math-parity` / `_vs-clip-parity` / `_dequant-parity` mechanism — it
runs under SwiftShader, so it can be a CI gate. To localize a fill-vs-outline
or polygon-vs-line split, extend it to compare the TWO vertex shaders' world
positions for the same input vertex; whichever ≠ the CPU mirror is the culprit
term (a uniform: `tile_extent_m`, RTC `cam_h/cam_l`, the in-shader inverse-Merc).

### 3. Visual bisect (which path is RIGHT) — `visual-artifact-bisect`

Real-GPU headed screenshot, toggle ONE variable. fill-only vs outline-only at
the broken camera tells which path matches the reference; zoom sweep (z14 →
over-zoom) tells if the error scales with magnification (⇒ a fixed pre-magnify
origin/scale offset). The pixels are the judge; never ship a fix reasoned only
from a static read.

## Call-sequence / outgoing-call extraction

LSP gives STRUCTURE, not order. `lsp_document_symbols` returns each function's
line range; the call SEQUENCE is the body in source order plus its visible
branches — read it, or runtime-trace for the data-dependent path actually
taken. `callHierarchy/outgoingCalls` (when exposed) is an UNORDERED callee set,
not control flow. ast-grep (`$F($$$A)`) extracts call expressions in source
order IF `@ast-grep/napi` is installed (it is not, by default — install before
relying on it).

## Worked examples

**Outline offset from fill at over-zoom (H2).** 1a: `devAssertClose` the fill
vs outline first-vertex geo at the upload site → fires ⇒ data, passes ⇒ shader.
1b: readback vs_main vs vs_line world pos. 1c: fill-only/outline-only z19.4 +
z14→19.4 sweep (gap ∝ magnification ⇒ fixed pre-magnify origin split).

**Line renders too thin at over-zoom.** 2a: `devWatch('lineWidth', …,
{evalZoom, screenZoom})` → `evalZoom == parentZoom` while `screenZoom` is the
over-zoom level ⇒ width interpolated at the wrong zoom (CPU). 2b: readback the
expanded quad half-width vs `widthPx/2` ⇒ shader expansion factor wrong. 2c:
measure rendered thickness in px across the zoom sweep.

## Hard-won

- **Invariant → assert.** Every INVARIANT a prove-or-refute refutation
  establishes should become a live `devAssert`/`devAssertClose` at the site it
  governs — that's how a one-time proof becomes a permanent tripwire.
- **CPU assert before GPU readback before pixels.** The CPU cross-path check is
  the single highest-value probe: it splits data-cause from shader-cause for
  free, before you spend a GPU round-trip.
- **`devWatch` beats a screenshot for coverage** — it watches execution, not
  the one frame you captured. Reach for it when the bug "only happens
  sometimes / somewhere".
- **Strip-verify once:** after wiring asserts into a hot path, confirm the
  production bundle drops them (grep the built `dist` for an assert message
  string → must be absent) so they never cost a shipped frame.
