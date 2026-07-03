---
name: shader-dsl-render-verify-self-diff-floor
description: verify a semantic-equivalent (non-byte) shader change is render-identical via a SELF-DIFF control, not an absolute pixel-% threshold
triggers:
  - 'render identical'
  - 'GPU pixel diff'
  - 'self-diff floor'
  - 'non-determinism floor'
  - 'shader change verify'
  - 'semantic not byte'
  - 'OFM-bright render'
---

# Verifying a shader change is render-identical — the self-diff floor

## The Insight

Many `@xgis/shader-dsl` authoring changes (auto-var names `_vN`, `.assign()` rename, `radians()` swap,
combinator/Switch rewrites) are SEMANTIC-equivalent but NOT byte-identical (the emitted WGSL text changes).
A real-GPU OFM-bright render of such a change always shows a nonzero pixel diff vs the baseline — because
the render itself is non-deterministic run-to-run (label placement, tile timing). So an absolute pixel-%
threshold is meaningless. The only sound gate is a SELF-DIFF CONTROL: render the SAME code twice and diff
those, to measure that run's non-determinism floor. The change is render-identical iff
`base-vs-new ≤ self-diff-floor` AND the diff sits in the SAME bbox.

## Why This Matters

Without the self-diff control you'll either (a) reject a correct change because base-vs-new is 0.5% (which
is just noise), or (b) accept a real regression hidden under a high absolute threshold. The floor varies
per session (≈0.2%–0.5%) and lives in a label strip around x≈763–860, y≈352–699.

## Recognition Pattern

- The change altered the emitted WGSL (snapshots changed / rebaked) but is meant to be behaviorally identical.
- You need to prove "no visual regression" but `Read` downscales the frame (CLAUDE.md §5 forbids eyeballing).

## The Approach

1. Render OFM-bright TWICE on the changed branch → `new`, `new2`. Diff them = the self-diff FLOOR (nz%, bbox).
2. Render the baseline (checkout main / stash the change) once → `base`. Diff `base` vs `new`.
3. PASS iff base-vs-new nz% ≤ self-diff nz% AND the same bbox. Pixel COUNT below the floor = render-identical.
4. ⚠️ Python (Windows) can't open git-bash `/tmp/...` paths — copy the PNGs to the repo dir and use Windows
   paths (`r'D:\X-GIS\.x.png'`) in the PIL/numpy diff, or it FileNotFoundErrors on existing files.
5. A genuinely numerical change (e.g. exact-π `radians()` vs a rounded constant) is still sub-pixel here, so
   it lands within the floor — but a STRUCTURAL break (wrong var, dropped shield) exceeds the floor and/or
   moves the bbox. Read a ×5 crop of any out-of-floor region before judging.
