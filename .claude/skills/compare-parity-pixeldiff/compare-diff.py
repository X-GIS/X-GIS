#!/usr/bin/env python3
"""Directional pixel-diff for render parity verification (CLAUDE.md §5).

Compares two same-size PNGs and reports:
  - diffPct   : % of pixels whose |luminance delta| exceeds --threshold
  - meanAbs   : mean absolute luminance delta over all pixels (0..255 scale)
  - worstTiles: the 4x4 tile grid ranked by per-tile diffPct, worst first
and (with --out) writes a full-resolution DIRECTIONAL diff image:
  red  = first image brighter, blue = second image brighter, black = equal.
That signed encoding is what makes the §5 reading semantics work — paired
red/blue parallel edges = positional shift; red on both sides of a stroke =
width change; solid blocks = fill/colour change; text-only = glyph engine.

GATING IS THE CALLER'S JOB. This script only measures. Per §5, gate the
ladder directionally — DC > 0 (before-vs-after proves the change landed) and
D1 < D0 (vs-MapLibre proves the direction) — never on an absolute %.
Ladder rungs (§12): directional diff → threshold DC=0 → hash equality.

Zero dependencies: pure-Python PNG codec (zlib + struct) below, supporting
what our harnesses emit — 8-bit greyscale / RGB / RGBA, non-interlaced.
Interlaced, paletted, or 16-bit input is rejected with a clear error
(re-export the capture rather than extending this decoder).

Usage:
  compare-diff.py A.png B.png [--out diff.png] [--threshold 8] [--grid 4] [--json]
Exit codes: 0 = compared (whatever the numbers); 2 = unreadable/size mismatch.

Reconstructed 2026-08-24 (#2012 prerequisite 1): the original script predated
the repo's skill tracking and was never committed; behaviour re-derived from
CLAUDE.md §5's contract.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib

# ── minimal PNG codec ──────────────────────────────────────────────────────

_SIG = b"\x89PNG\r\n\x1a\n"


def read_png(path: str) -> tuple[int, int, int, bytearray]:
    """Return (width, height, channels, raw) with raw = channels bytes/pixel."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != _SIG:
        raise ValueError(f"{path}: not a PNG")
    pos, w, h, bitd, ctype, interlace = 8, 0, 0, 0, 0, 0
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            w, h, bitd, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
    if bitd != 8:
        raise ValueError(f"{path}: bit depth {bitd} unsupported (8 only)")
    if interlace:
        raise ValueError(f"{path}: interlaced PNG unsupported")
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype)
    if channels is None:
        raise ValueError(f"{path}: colour type {ctype} unsupported (grey/RGB/RGBA)")
    raw = zlib.decompress(bytes(idat))
    stride = w * channels
    out = bytearray(h * stride)
    prev = bytearray(stride)
    src = 0
    for y in range(h):
        ftype = raw[src]
        src += 1
        line = bytearray(raw[src : src + stride])
        src += stride
        if ftype == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ftype != 0:
            raise ValueError(f"{path}: unknown filter {ftype}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return w, h, channels, out


def write_png(path: str, w: int, h: int, rgb: bytes) -> None:
    """Write an RGB8 PNG (filter 0 rows, single IDAT)."""
    stride = w * 3
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgb[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(_SIG)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
        f.write(chunk(b"IEND", b""))


def luminance_plane(w: int, h: int, channels: int, raw: bytearray) -> bytearray:
    """Integer BT.601-ish luma; alpha is ignored (renders are opaque)."""
    lum = bytearray(w * h)
    if channels == 1:
        return bytearray(raw)
    if channels == 2:  # grey + alpha
        for i in range(w * h):
            lum[i] = raw[2 * i]
        return lum
    for i in range(w * h):
        o = i * channels
        lum[i] = (raw[o] * 77 + raw[o + 1] * 150 + raw[o + 2] * 29) >> 8
    return lum


# ── diff ───────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--out", help="write the directional diff image here")
    ap.add_argument("--threshold", type=int, default=8, help="|delta| counted as diff (default 8)")
    ap.add_argument("--grid", type=int, default=4, help="tile grid per axis (default 4)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    try:
        wa, ha, ca, ra = read_png(args.a)
        wb, hb, cb, rb = read_png(args.b)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if (wa, ha) != (wb, hb):
        print(f"error: size mismatch {wa}x{ha} vs {wb}x{hb}", file=sys.stderr)
        return 2

    la = luminance_plane(wa, ha, ca, ra)
    lb = luminance_plane(wb, hb, cb, rb)

    n = wa * ha
    grid = max(1, args.grid)
    tile_cnt = [[0] * grid for _ in range(grid)]
    tile_tot = [[0] * grid for _ in range(grid)]
    over = 0
    abs_sum = 0
    diff_img = bytearray(n * 3) if args.out else None
    # amplification for the diff image: small real deltas must stay visible
    # at a glance without saturating structure (x4, clamped).
    for y in range(ha):
        ty = y * grid // ha
        row = y * wa
        for x in range(wa):
            i = row + x
            d = la[i] - lb[i]
            ad = d if d >= 0 else -d
            abs_sum += ad
            tx = x * grid // wa
            tile_tot[ty][tx] += 1
            if ad > args.threshold:
                over += 1
                tile_cnt[ty][tx] += 1
            if diff_img is not None and ad:
                v = ad * 4
                v = 255 if v > 255 else v
                o = i * 3
                if d > 0:
                    diff_img[o] = v  # red: A brighter
                else:
                    diff_img[o + 2] = v  # blue: B brighter

    diff_pct = 100.0 * over / n
    mean_abs = abs_sum / n
    tiles = [
        (f"r{r}c{c}", 100.0 * tile_cnt[r][c] / max(1, tile_tot[r][c]))
        for r in range(grid)
        for c in range(grid)
    ]
    tiles.sort(key=lambda t: -t[1])

    if diff_img is not None:
        write_png(args.out, wa, ha, bytes(diff_img))

    if args.json:
        print(
            json.dumps(
                {
                    "width": wa,
                    "height": ha,
                    "threshold": args.threshold,
                    "diffPct": round(diff_pct, 4),
                    "meanAbs": round(mean_abs, 4),
                    "worstTiles": [{"tile": t, "pct": round(p, 4)} for t, p in tiles],
                    "out": args.out,
                }
            )
        )
    else:
        print(f"diffPct={diff_pct:.4f}% meanAbs={mean_abs:.4f} threshold={args.threshold}")
        worst = "  ".join(f"{t}:{p:.2f}%" for t, p in tiles[:6])
        print(f"worstTiles: {worst}")
        if args.out:
            print(f"diff image: {args.out} (red = {args.a} brighter, blue = {args.b} brighter)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
