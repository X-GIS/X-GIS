---
name: compare-parity-pixeldiff
description: >
  Directional pixel-diff verification for ANY claim that a render is correct, a
  parity fix works, or there is no regression (CLAUDE.md §5 — MANDATORY, never
  optional). Produces the DC / D0 / D1 ladder numbers and a signed red/blue
  diff image, then hands the image to tile-crop-review for full-resolution
  reading. Use before/after any render-touching change, in multi-style sweeps,
  and for post-merge confirmation. Eyeballing a downscaled frame or composite
  is NOT verification and is explicitly forbidden.
---

# compare-parity-pixeldiff — the directional diff ladder

Every §5 verification runs `compare-diff.py` (this directory; zero
dependencies, pure Python 3) at least twice:

1. **DC — before vs after (X-GIS vs X-GIS).** Proves WHAT changed.
   A fix that claims a visual effect must show `DC > 0`; a refactor that
   claims none must show `DC = 0` (then climb to the hash rung below).
2. **D0 / D1 — vs MapLibre (or the reference renderer).** Proves the
   DIRECTION: `D0` = reference↔X-GIS *before*, `D1` = reference↔X-GIS
   *after*. The fix is only "toward parity" when `D1 < D0`.

```bash
python3 .claude/skills/compare-parity-pixeldiff/compare-diff.py \
  before.png after.png --out dc.png            # DC
python3 .claude/skills/compare-parity-pixeldiff/compare-diff.py \
  maplibre.png xgis-before.png --json          # D0
python3 .claude/skills/compare-parity-pixeldiff/compare-diff.py \
  maplibre.png xgis-after.png --json           # D1
```

## Gating rules (the whole point)

- Gate on **`DC > 0` and `D1 < D0`** — NEVER on an absolute percentage.
  The reference↔X-GIS absolute diff is noisy (AA, glyph engines, gamma);
  its *movement* is the signal.
- Render-gate ladder (§12): **directional diff → threshold `DC = 0` →
  hash equality** (`md5sum` on captures from a deterministic harness:
  fixed camera, pumped convergence, software rasterizer). Measure the
  SAME-CODE noise floor before trusting any rung.
- Numbers never decide alone: after the numbers, **read the diff image**
  with `tile-crop-review` (16-split at full resolution, worst tiles
  first — the `worstTiles` output names where to look) and a ×5 crop of
  the hot region.
- Measure pixel width before calling an edge diff a width bug — the
  eyeball lies on width.

## Reading the diff image

Signed encoding: **red = first argument brighter, blue = second argument
brighter**, black = equal (amplified ×4 for visibility).

| pattern | meaning |
| --- | --- |
| paired red/blue parallel edges | positional shift |
| red (or blue) on BOTH sides of a stroke | width change |
| solid filled blocks | fill / colour change |
| diff confined to text | glyph engine difference |

## Failure modes this skill exists to kill

- Judging a render by a downscaled full frame or side-by-side composite —
  `Read` downscales large images, silently erasing the sub-pixel offsets,
  seams, missing shields, and width changes real bugs live in.
- Passing a pixel-COUNT gate on a broken image (§12: 1.5% "green" on a
  disconnected seam) — assert structure or read the frame, never count
  alone.
- Trusting an absolute reference-diff % — it can improve while the render
  gets worse, and vice versa. Direction only.
