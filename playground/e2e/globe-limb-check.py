#!/usr/bin/env python3
"""Globe LIMB inspector — detect problems on the sphere's OUTER EDGE (외각 라인).

Reads a rendered globe PNG and reports:
  - disk center + radius (auto-detected from the globe surface)
  - LIMB GAPS: sectors of the rim where the background shows through instead of
    the sphere surface (missing edge tiles / black wedges)
  - INNER-LIP: radial surface->background transitions INSIDE the disk — the
    perspective-horizon back-lip (a smaller sphere edge inside the silhouette)
    or an interior tile gap
It also crops the limb annulus into angular patches (saved next to the PNG) so
the MAIN CONTEXT can read each rim segment up close (tile-crop-review).

Usage: python globe-limb-check.py <globe.png> [crops_out_dir]
Exit 0 if the limb is clean (no gap sectors, no inner-lip), 1 otherwise.
"""
import sys
import os
import numpy as np
from PIL import Image

# Surface = a pixel that belongs to the globe disk (ocean navy, land green/white),
# i.e. NOT the near-black background and NOT the HUD chrome. The HUD is the killer:
# its grey text matches a naive "white land" predicate and inflates the disk bbox,
# so we ZERO OUT the known HUD zones (top-left zoom box, bottom caption strip,
# bottom-right error box) before classifying.
def surface_mask(im):
    H, W, _ = im.shape
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    bg = (r + g + b) < 45
    ocean = (b > 45) & (b > r + 8) & (b >= g - 12)
    land_green = (g > 90) & (g > r + 30) & (g > b + 12)
    land_white = (r > 150) & (g > 150) & (b > 150)
    m = (ocean | land_green | land_white) & (~bg)
    # Knock out HUD chrome zones (fractions of frame; generous margins).
    hud = np.zeros((H, W), bool)
    hud[: int(H * 0.06), : int(W * 0.40)] = True            # top-left zoom readout
    hud[int(H * 0.95):, :] = True                            # bottom caption strip
    hud[int(H * 0.80):, int(W * 0.72):] = True               # bottom-right error box
    hud[: int(H * 0.05), int(W * 0.72):] = True              # top-right snapshot button
    m[hud] = False
    return m


def detect_disk(surf):
    # Widest surface row = disk equator -> center_y + horizontal extent.
    row = surf.sum(axis=1)
    cy = int(np.argmax(row))
    xs = np.where(surf[cy])[0]
    cx_a, radx = (xs.min() + xs.max()) / 2, (xs.max() - xs.min()) / 2
    # Tallest surface column -> center_x + vertical extent.
    col = surf.sum(axis=0)
    cx_b = int(np.argmax(col))
    ys = np.where(surf[:, cx_b])[0]
    cy_b, rady = (ys.min() + ys.max()) / 2, (ys.max() - ys.min()) / 2
    cx = (cx_a + cx_b) / 2
    cy = (cy + cy_b) / 2
    R = (radx + rady) / 2
    return cx, cy, R


def main(path, crops_dir=None):
    im = np.asarray(Image.open(path).convert('RGB')).astype(int)
    H, W, _ = im.shape
    surf = surface_mask(im)
    if surf.sum() < 500:
        print('LIMB: no globe disk detected (surface px < 500) — not a globe frame?')
        return 1
    cx, cy, R = detect_disk(surf)

    # --- LIMB RING walk: just INSIDE the edge, the sphere surface (ocean) should
    #     be continuous all the way around. A background sample = a gap sector. ---
    N = 720
    rr = R - 3
    gap_deg = []
    for i in range(N):
        th = 2 * np.pi * i / N
        x = int(round(cx + rr * np.cos(th)))
        y = int(round(cy + rr * np.sin(th)))
        if 0 <= x < W and 0 <= y < H and not surf[y, x]:
            gap_deg.append(i * 360.0 / N)
    gap_frac = len(gap_deg) / N

    # --- INNER-LIP: along radial lines, the profile from center out to the edge
    #     should be ALL surface (ocean<->land transitions are fine; both surface).
    #     A surface->BACKGROUND transition BEFORE the edge = an interior gap or the
    #     back-lip ring. Count angles where that happens (scan to R-2 to skip the
    #     normal anti-aliased edge). ---
    lip_deg = []
    for i in range(0, N, 4):
        th = 2 * np.pi * i / N
        prof = []
        for t in range(6, int(R) - 2):
            x = int(round(cx + t * np.cos(th)))
            y = int(round(cy + t * np.sin(th)))
            prof.append(bool(surf[y, x]) if 0 <= x < W and 0 <= y < H else False)
        trans = sum(1 for j in range(1, len(prof)) if prof[j - 1] and not prof[j])
        if trans >= 1:
            lip_deg.append(i * 360.0 / N)

    def sectors(degs, step=0.5):
        # collapse a sorted angle list into contiguous [a,b] sectors
        if not degs:
            return []
        out = [[degs[0], degs[0]]]
        for d in degs[1:]:
            if d - out[-1][1] <= step * 3:
                out[-1][1] = d
            else:
                out.append([d, d])
        return out

    gsec = sectors(gap_deg)
    lsec = sectors([float(d) for d in lip_deg], step=4 * 360.0 / N)

    print(f'LIMB disk: center=({cx:.0f},{cy:.0f}) R={R:.0f}px  surface_px={int(surf.sum())}')
    print(f'LIMB ring gaps: {len(gap_deg)}/{N} samples ({gap_frac*100:.1f}%) in {len(gsec)} sector(s)')
    for a, b in gsec[:12]:
        print(f'   gap sector {a:.0f}deg..{b:.0f}deg')
    print(f'LIMB inner-lip / interior gaps: {len(lsec)} angular run(s)')
    for a, b in lsec[:12]:
        print(f'   inner-transition {a:.0f}deg..{b:.0f}deg')

    # --- CROPS: 12 patches straddling the rim at evenly spaced angles, for the
    #     main context to read each segment up close. 0deg = +x (east), CW. ---
    if crops_dir is None:
        crops_dir = os.path.join(os.path.dirname(path),
                                 os.path.splitext(os.path.basename(path))[0] + '_limb')
    os.makedirs(crops_dir, exist_ok=True)
    img = Image.fromarray(im.astype('uint8'))
    half = 90
    n_crops = 12
    for i in range(n_crops):
        th = 2 * np.pi * i / n_crops
        px = int(cx + R * np.cos(th))
        py = int(cy + R * np.sin(th))
        box = (max(0, px - half), max(0, py - half),
               min(W, px + half), min(H, py + half))
        deg = int(i * 360 / n_crops)
        img.crop(box).save(os.path.join(crops_dir, f'limb_{deg:03d}deg.png'))
    print(f'LIMB crops: {n_crops} rim patches -> {crops_dir}')

    clean = (gap_frac < 0.01) and (len(lsec) == 0)
    print('LIMB verdict:', 'CLEAN' if clean else 'PROBLEMS DETECTED')
    return 0 if clean else 1


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: python globe-limb-check.py <globe.png> [crops_out_dir]')
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
