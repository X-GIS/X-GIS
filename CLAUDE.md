# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 5. Render / Parity Verification — MANDATORY (never skip, not "if I remember")

This OVERRIDES default behavior. Applies to EVERY claim that a render is correct, a
parity fix works, or there is no regression — including before/after checks, multi-style
sweeps, and post-merge confirmation. The methods below live as skills
(`compare-parity-pixeldiff`, `tile-crop-review`); treating them as optional is the
recurring mistake. They are NOT optional here.

**Forbidden:** judging a render by eyeballing a downscaled full frame or a downscaled
side-by-side composite. `Read` downscales large images, so this silently loses the
sub-pixel offsets, seams, missing shields, and width changes that real bugs live in.
Eyeballing a downscaled composite is NOT verification.

**Required, every time:**
1. **Directional pixel-diff** with `.claude/skills/compare-parity-pixeldiff/compare-diff.py`
   — before-vs-after (DC: proves what changed) and vs MapLibre (D0/D1: proves direction).
   The ML↔X-GIS absolute diff is noisy; gate on DC>0 and D1<D0, never on an absolute %.
2. **Read the diff IMAGE in a 16-split (4×4) grid at full resolution** (tile-crop-review),
   worst tiles first — paired red/blue parallel edges = positional shift; red both sides =
   width change; solid blocks = fill/colour; text-only = glyph engine. Numbers never decide
   alone; read the diff image AND a ×5 crop of the hot region.
3. **Measure pixel width** before calling an edge diff a width bug (eyeball lies on width).

For a whole-frame fidelity pass, 16-split the frame itself and read each tile. A scalar
ratio or a downscaled glance is a tripwire, not a verdict.

---

## 6. Code Discovery — codebase-memory MCP FIRST (mandatory, not "if I remember")

This OVERRIDES default behavior. When LOCATING code — a function/class/route/variable, who
calls it, what it calls, its data flow, or how a subsystem is structured — query the
`codebase-memory` MCP graph FIRST, not Grep/Glob/Read. Reaching for Grep first is the
recurring mistake; the graph surfaces the cross-path consumers and call chains a text
search misses (exactly the blast radius this codebase's bugs hide in).

**Use first (project="D-X-GIS"):**
- `search_graph` (name_pattern / label / qn_pattern / query) — find definitions & symbols
- `trace_path` (mode: calls | data_flow | cross_service) — callers, callees, impact, data flow
- `get_code_snippet` (qualified_name) — exact symbol source
- `query_graph` (Cypher) — complex relationship queries
- `search_code` — graph-augmented grep when you must text-match
- `get_architecture` — package/module structure
If the project is not indexed yet, run `index_repository` first.

**Grep / Glob / Read remain correct for:** non-code text, configs, comments, docs; and you
must ALWAYS `Read` a file before editing it. The rule is graph-first for *finding* code —
not a ban on Read. Pairs with the `flow-first` skill: graph the call/data flow + blast
radius before editing.