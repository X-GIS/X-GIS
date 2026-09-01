---
name: tile-crop-review
description: >
  Full-resolution image reading for render verification (CLAUDE.md §5 —
  MANDATORY companion to compare-parity-pixeldiff). Splits a frame or diff
  image into a 4x4 grid of full-resolution tiles plus a x5 magnified crop of
  the hot region, because `Read` downscales large images and silently erases
  the sub-pixel offsets, seams, missing shields, and width changes real bugs
  live in. Use whenever a §5 verification says "read the diff image" or a
  whole-frame fidelity pass is required.
---

# tile-crop-review — the 16-split reading method

A large image is never judged whole: split it, then `Read` each tile at its
native resolution, **worst tiles first** (compare-diff.py's `worstTiles`
output names the order).

```bash
python3 .claude/skills/tile-crop-review/tile-crop.py dc.png /tmp/tiles          # 4x4 tiles
python3 .claude/skills/tile-crop-review/tile-crop.py dc.png /tmp/tiles \
  --crop 640,320,256,128 --scale 5                                              # x5 hot region
# then Read /tmp/tiles/tile-r0c2.png, /tmp/tiles/crop-x5.png, ...
```

Tiles are written `tile-r{row}c{col}.png`, row-major from the top-left, cut
with the same `N*i//grid` boundaries compare-diff.py uses — a `worstTiles`
entry `r1c2` is exactly the file `tile-r1c2.png`.

## Reading semantics (on a signed red/blue diff image)

| pattern | verdict |
| --- | --- |
| paired red/blue parallel edges | positional shift (measure the offset) |
| red (or blue) on BOTH sides of a stroke | width change — MEASURE pixel width before calling it one; the eyeball lies on width |
| solid filled blocks | fill / colour change |
| diff confined to glyphs | glyph engine difference |
| thin connected single-colour runs | seam artifact — check structure, not just counts |

## Rules

- Numbers never decide alone; a scalar ratio or a downscaled glance is a
  tripwire, not a verdict. The verdict comes from reading the tiles AND the
  ×5 crop of the hot region.
- For a whole-frame fidelity pass (no diff image), 16-split the frame itself
  and read every tile.
- A pixel-COUNT gate passes on broken images (§12: 1.5% "green" on a
  disconnected seam line) — assert structure (connectedness / no-seam-run /
  expected shape) or read the frame at full resolution.
- Nearest-neighbour magnification only (the script's `--scale`) — resampling
  would manufacture or erase the sub-pixel evidence being judged.
