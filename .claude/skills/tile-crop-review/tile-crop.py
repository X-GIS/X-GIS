#!/usr/bin/env python3
"""16-split (grid) and magnified-crop extraction for full-resolution image
reading (CLAUDE.md §5 / tile-crop-review).

`Read` downscales large images, silently erasing sub-pixel offsets, seams and
width changes — so a frame or diff image is reviewed by splitting it into an
N×N grid of FULL-RESOLUTION tiles (default 4×4 = the §5 16-split) and reading
the tiles individually, worst first. A ×K nearest-neighbour crop magnifies the
hot region without resampling artifacts.

Usage:
  tile-crop.py IMG OUT_DIR [--grid 4] [--crop X,Y,W,H --scale 5]
Writes OUT_DIR/tile-r{row}c{col}.png (row-major) and, with --crop,
OUT_DIR/crop-x{scale}.png. Exit 0 on success, 2 on unreadable input.

Self-contained on purpose (a skill directory must be copyable alone), so the
minimal PNG codec is duplicated from compare-parity-pixeldiff/compare-diff.py
— 8-bit grey/RGB/RGBA, non-interlaced, the formats our harnesses emit.

Reconstructed 2026-08-24 (#2012 prerequisite 1): the original predated the
repo's skill tracking and was never committed.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import zlib

_SIG = b"\x89PNG\r\n\x1a\n"


def read_png(path: str) -> tuple[int, int, int, bytearray]:
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
    if bitd != 8 or interlace:
        raise ValueError(f"{path}: only 8-bit non-interlaced PNGs supported")
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype)
    if channels is None:
        raise ValueError(f"{path}: colour type {ctype} unsupported")
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
        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
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


def write_png(path: str, w: int, h: int, channels: int, raw: bytes) -> None:
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[channels]
    stride = w * channels
    body = bytearray()
    for y in range(h):
        body.append(0)
        body += raw[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(_SIG)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(body), 6)))
        f.write(chunk(b"IEND", b""))


def crop_region(
    w: int, h: int, channels: int, raw: bytearray, x0: int, y0: int, cw: int, ch: int
) -> bytes:
    x0 = max(0, min(x0, w - 1))
    y0 = max(0, min(y0, h - 1))
    cw = max(1, min(cw, w - x0))
    ch = max(1, min(ch, h - y0))
    out = bytearray(cw * ch * channels)
    for y in range(ch):
        src = ((y0 + y) * w + x0) * channels
        dst = y * cw * channels
        out[dst : dst + cw * channels] = raw[src : src + cw * channels]
    return bytes(out)


def scale_nn(w: int, h: int, channels: int, raw: bytes, k: int) -> bytes:
    ow, oh = w * k, h * k
    out = bytearray(ow * oh * channels)
    for y in range(oh):
        srow = (y // k) * w * channels
        drow = y * ow * channels
        for x in range(ow):
            s = srow + (x // k) * channels
            d = drow + x * channels
            out[d : d + channels] = raw[s : s + channels]
    return bytes(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("img")
    ap.add_argument("out_dir")
    ap.add_argument("--grid", type=int, default=4, help="tiles per axis (default 4 = 16-split)")
    ap.add_argument("--crop", help="X,Y,W,H region to magnify")
    ap.add_argument("--scale", type=int, default=5, help="crop magnification (default 5)")
    args = ap.parse_args()

    try:
        w, h, channels, raw = read_png(args.img)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    os.makedirs(args.out_dir, exist_ok=True)

    g = max(1, args.grid)
    for r in range(g):
        y0 = h * r // g
        y1 = h * (r + 1) // g
        for c in range(g):
            x0 = w * c // g
            x1 = w * (c + 1) // g
            tile = crop_region(w, h, channels, raw, x0, y0, x1 - x0, y1 - y0)
            path = os.path.join(args.out_dir, f"tile-r{r}c{c}.png")
            write_png(path, x1 - x0, y1 - y0, channels, tile)
    print(f"{g}x{g} tiles -> {args.out_dir}/tile-r*c*.png ({w}x{h} source, full resolution)")

    if args.crop:
        try:
            x, y, cw, ch = (int(v) for v in args.crop.split(","))
        except ValueError:
            print("error: --crop expects X,Y,W,H integers", file=sys.stderr)
            return 2
        region = crop_region(w, h, channels, raw, x, y, cw, ch)
        cw = max(1, min(cw, w - max(0, min(x, w - 1))))
        ch = max(1, min(ch, h - max(0, min(y, h - 1))))
        mag = scale_nn(cw, ch, channels, region, max(1, args.scale))
        path = os.path.join(args.out_dir, f"crop-x{args.scale}.png")
        write_png(path, cw * args.scale, ch * args.scale, channels, mag)
        print(f"crop {args.crop} x{args.scale} -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
