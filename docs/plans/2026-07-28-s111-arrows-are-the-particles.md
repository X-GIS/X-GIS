# The S-111 arrows ARE the particles (#1409)

## What this is

The catalogue arrow itself drifts through the current. Not a dot beside it, not a trail behind
it, not a texture under it — the SCAROW glyph moves, and wherever it arrives it is re-symbolized
from the data at that position: band colour, rotation, scale, per `select_arrow.xsl`.

Three earlier attempts put the motion in a SEPARATE layer (glyph drift → reverted, IBFV noise
modulating the fill, then a particle-dot layer over static arrows). All three were rejected. The
reason they kept happening was an objection I raised and then treated as settled: recycling a
recognizable glyph needs a fade, and a fade on a large glyph reads as a blink. That is a thing to
handle (spread retirement, below), not a reason to reject the design.

## What the catalogue actually constrains

Read from the vendored `docs/standards/s-111/portrayal/XSLT/Rules/`:

- `coverageFill` + `placement: directPosition` — the symbol is placed at a POINT position, not
  as an area fill.
- nine `lookup`s keyed on `surfaceCurrentSpeed` → `SCAROW01..09`.
- `rotationAttribute = surfaceCurrentDirection`, `rotationCRS = GeographicCRS`, factor 1.0.
- scale: bands 1–3 fixed `0.40`, bands 4–8 `speed × 0.20`, band 9 fixed `2.60`.
- `main.xsl` note (4): no symbol for speed 0 or noData.
- all nine SVGs are the SAME path; only the fill class `fSCBN1..9` differs.

What it does NOT contain is any notion of TIME. The portrayal catalogue describes one static
instant. So "the arrows must stay pinned to grid points forever" was never a catalogue rule —
it was an assumption. What the catalogue binds is a FUNCTION: at a position, (speed, direction)
determine symbol, colour, rotation and scale. An arrow that moves and re-evaluates that function
at its new position is conformant; one that keeps its old colour after moving is not.

## The constraint that shapes the implementation

`arrow-retained.ts`'s `project_geo` consumes **df64-split** coordinates — `ecef_*_h`/`ecef_*_l`
and `merc_*_h`/`merc_*_l`. The split is not decoration: f32 at Earth radius resolves ~0.5 m, so
the camera-relative subtraction must happen in extended precision or high-zoom placement breaks.
Those splits are computed on the CPU, once, per instance.

An arrow at a freely-varying position would need them recomputed every frame. Both obvious ways
out are closed:

- **Re-pack on the CPU each frame** — one full regeneration measured ~27 ms on a 596×433 CBOFS
  grid (#67, reported as playback stutter). Not a slower option; a non-option.
- **Recompute the projection in the shader** — a GPU twin of CPU projection math is the
  archetype CLAUDE.md §12 names as this codebase's dominant bug source, and it degrades exactly
  where the df64 split exists to help.

## The design that avoids both

Split the position into a part the CPU already knows exactly and a part small enough for f32.

```
state texture           continuous grid-uv position         (arrow-advect-state.ts)
      │
      ├── floor(uv × gridSize) ──► CELL INDEX
      │        └── indexes the CPU-packed per-cell geo table (df64, exactly as today)
      │            → an EXACT anchor, with no new projection math
      │
      └── frac(uv × gridSize) ──► SUB-CELL REMAINDER, < 1 cell
               └── added as a small screen-space offset, where f32 is ample
```

The cell table is what `coverage-arrow-show.ts` already builds; it is only re-indexed — by cell
rather than by instance — instead of being rebuilt.

This gives both properties the previous options each gave only one of: arrows travel the whole
domain (the cell index is unbounded), and the motion is smooth (the sub-cell remainder is
continuous). Placement authority stays on the CPU.

Bearing, band colour and scale come from sampling `flowU`/`flowV` at the CONTINUOUS uv and
looking up `s111BandTable()` — the catalogue rule uploaded as data, so the shader holds no
threshold and no colour of its own.

## Recycling without a blink

An arrow that leaves the domain, or lands where speed is 0 / noData (catalogue note 4 — no
symbol), retires and respawns elsewhere. Retirement is spread by a per-arrow speed-biased
lottery, so a few of 16 384 go each frame rather than a visible wave. No lifetime fade is used:
a fade is what makes a retirement legible, and staggering removes the need for one.

## Landed so far

- `feat(rhi)` — a bind layout can opt a texture into the VERTEX stage (`vertexVisible`), so the
  arrow VS can read the state texture. Opt-in, because WebGPU counts sampled textures per stage.
- `feat(map)` — `s111BandTable()`, the catalogue rule as GPU-indexable data, gated by
  reproducing `bandedRampColor` and `s111ArrowScale` rather than by transcription.
- `feat(map)` — `ArrowAdvectState` + `arrow-advect-step`, the position ping-pong and the pass
  that advances it by sampling the velocity field.

## Remaining

1. Per-cell geo table: re-index `coverage-arrow-show.ts`'s output by cell instead of instance.
2. Arrow VS advected path: cell index + sub-cell offset from the state texture; bearing, colour
   and scale from the field and the band table. Kept off the existing `| arrow` path (Point
   sources) so that stays byte-identical.
3. Wire the advect step into the frame, alongside the existing flow pass.
4. Render gate: the arrows MOVE, and an arrow's colour changes when it crosses a band edge —
   the second half matters, because arrows that move while keeping their launch colour is the
   failure that still looks like a working animation.
