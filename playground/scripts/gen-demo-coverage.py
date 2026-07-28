#!/usr/bin/env python3
# ═══ Synthetic S-100 demo-coverage generator (ADR-0010: read the standard in place) ═══
#
# Emits the two committed playground demo assets as real S-100 (DCF2 gridded) HDF5 —
# the SAME standard the built-in `coverage` source now reads IN PLACE
# (readCoverageFromHdf5), so the demos exercise the exact runtime path a converted
# NOAA cell would, with no house `.xgcov` blob (the custom-format trap; ADR-0010):
#   • synthetic-bathymetry.h5 — S-102, 32×32 @ 50-58°N, a north→south depth ramp,
#     a nodata hole, and 4 known corner cells (the #1158 gate-3 fixture, re-platformed).
#   • synthetic-currents.h5   — S-111, 32×48 Chesapeake-shaped tidal field (a northward
#     channel + a CCW gyre, coast-shaped nodata margins), real S-111 band names/units/
#     -9999 fill (the #1272 demo field, re-platformed from gen-synthetic-currents.ts).
#   • synthetic-currents-south.h5 — the same field on a DELIBERATELY DIFFERENT GRID
#     (23×29, south of the first), so a mosaic gate has two domains whose arrow counts
#     and grid-uv origins actually differ. The committed east twin does not: it is the
#     32×48 field translated, so both domains carry identical origins and a state-texel
#     collision between them writes the same numbers back — invisible on screen, which
#     is exactly how a mosaic gate passed against the bug it was written to catch
#     (#1458). A gate needs a fixture that can disagree.
#
# NOT real NOAA data (synthetic closed-form fields; real cells stay local-only for
# licensing). h5py is the OFFLINE writer — NEVER linked into the shipped reader;
# regenerate from a throwaway venv:
#
#   python3 -m venv /tmp/h5venv && /tmp/h5venv/bin/pip install h5py numpy
#   /tmp/h5venv/bin/python playground/scripts/gen-demo-coverage.py
#
# The S-100 shape (container→instance→Group_001/values compound + a fixed-string
# Group_F band table, DCF2) mirrors data/tools/gen-h5-fixtures.py — the reader's own
# committed corpus is generated the same way. Values are stored SOUTH-ROW-FIRST (row
# 0 = grid origin = south), the S-100 native layout; readCoverageFromHdf5 owns the
# single north-up flip, so the north-up fields below are reversed before writing.

import os
import numpy as np
import h5py

# Demo assets are served from playground/public/data/ (the demo-runner resolves a
# scene's relative source URLs against `BASE_URL + 'data/'`, demo-runner.ts) — the
# same directory every geojson/odb fixture lives in.
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "data")

_GROUP_F = ["code", "name", "uom.name", "fillValue", "datatype", "lower", "upper", "closure"]


def _write_dcf2(g, container, nlat, nlon, origin_lon, origin_lat, d_lon, d_lat,
                bands, group_f_rows):
    """Write one DCF2 gridded feature: <container> → <container>.01 → Group_001/values
    (a packed compound over `bands`) + Group_F/<container> (fixed-string band table).
    `bands` = [(memberName, southFirstGrid), ...]; `group_f_rows` = the Group_F rows."""
    cont = g.create_group(container)
    cont.attrs["dataCodingFormat"] = np.uint8(2)
    cont.attrs["dimension"] = np.uint8(2)
    cont.attrs["numInstances"] = np.uint8(1)

    inst = cont.create_group(f"{container}.01")
    inst.attrs["gridOriginLongitude"] = np.float64(origin_lon)
    inst.attrs["gridOriginLatitude"] = np.float64(origin_lat)
    inst.attrs["gridSpacingLongitudinal"] = np.float64(d_lon)
    inst.attrs["gridSpacingLatitudinal"] = np.float64(d_lat)
    inst.attrs["numPointsLongitudinal"] = np.uint32(nlon)
    inst.attrs["numPointsLatitudinal"] = np.uint32(nlat)
    inst.attrs["startSequence"] = "0,0"

    grp = inst.create_group("Group_001")
    dt = np.dtype([(name, "<f4") for name, _ in bands])
    vals = np.zeros((nlat, nlon), dtype=dt)
    for name, grid in bands:
        vals[name] = grid
    grp.create_dataset("values", data=vals)

    gf = g.create_group("Group_F")
    width = max(max(len(c) for c in row) for row in group_f_rows)
    S = f"S{max(16, width)}"
    fdt = np.dtype([(k, S) for k in _GROUP_F])
    rows = np.array([tuple(c.encode() for c in row) for row in group_f_rows], dtype=fdt)
    gf.create_dataset(container, data=rows)
    gf.create_dataset("featureCode", data=np.array([container.encode()], dtype=S))


def bathymetry():
    """S-102, 32×32 @ 50-58°N: a linear north→south depth ramp (0 m north → 40 m
    south), a 6×6 nodata hole, and 4 known corner cells (NW=5, NE=15, SW=25, SE=35 m)
    the headed render gate reads back (_coverage-render.spec.ts)."""
    N = 32
    FILL = 1e6
    nu = np.zeros((N, N), dtype=np.float32)  # NORTH-UP: row 0 = north
    for r in range(N):
        nu[r, :] = 40.0 * r / (N - 1)  # north edge 0 m → south edge 40 m
    nu[13:19, 13:19] = FILL  # nodata hole (a 6×6 block in the centre)
    nu[0, 0], nu[0, N - 1] = 5.0, 15.0        # NW, NE
    nu[N - 1, 0], nu[N - 1, N - 1] = 25.0, 35.0  # SW, SE
    unc = np.full((N, N), 0.5, dtype=np.float32)
    gf = [
        ["depth", "depth", "metres", str(int(FILL)), "H5T_FLOAT", "-14", "11050", "closedInterval"],
        ["uncertainty", "uncertainty", "metres", str(int(FILL)), "H5T_FLOAT", "0", "", "geSemiInterval"],
    ]
    path = os.path.join(OUT, "synthetic-bathymetry.h5")
    with h5py.File(path, "w", libver="earliest") as f:
        f.attrs["productSpecification"] = "INT.IHO.S-102.3.0.0"
        f.attrs["horizontalCRS"] = np.int32(4326)
        f.attrs["verticalDatum"] = np.uint16(23)  # 23 = LAT
        # store SOUTH-FIRST (nu[::-1]); the reader flips back to north-up.
        _write_dcf2(f, "BathymetryCoverage", N, N, 0.0, 50.0, 0.25, 0.25,
                    [("depth", nu[::-1, :]), ("uncertainty", unc[::-1, :])], gf)
    return path, int((nu != FILL).sum()), float(nu[nu != FILL].max())


def currents():
    """S-111, 32×48 Chesapeake-shaped tidal field — a northward channel + a CCW gyre
    with coast-shaped nodata margins, carrying the real S-111 band names/units/-9999
    fill (the #1272 demo field, closed-form so regeneration is byte-stable)."""
    N_LON, N_LAT = 32, 48
    ORIGIN = (-76.58, 36.85)
    SPACING = (0.025, 0.055)
    FILL = -9999.0
    D2R = np.pi / 180.0
    speed = np.zeros((N_LAT, N_LON), dtype=np.float32)      # NORTH-UP: row 0 = north
    direction = np.zeros((N_LAT, N_LON), dtype=np.float32)
    for row in range(N_LAT):
        gy = 1 - row / (N_LAT - 1)  # northward fraction (0 = south edge, 1 = north)
        west_land = 0.1 + 0.06 * np.sin(gy * 5.1)
        east_land = 0.1 + 0.06 * np.cos(gy * 3.7)
        for col in range(N_LON):
            gx = col / (N_LON - 1)
            island = np.hypot(gx - 0.62, gy - 0.55) < 0.045
            if gx < west_land or gx > 1 - east_land or island:
                speed[row, col] = FILL
                direction[row, col] = FILL
                continue
            # Northward tidal channel, fastest mid-channel, with a gentle meander.
            ch = max(0.0, 1 - abs(gx - 0.5) / 0.5) ** 1.5
            ch_speed = 1.4 * ch
            ch_dir = -18 * np.sin(gy * 4.2) * D2R
            u = ch_speed * np.sin(ch_dir)  # east component
            v = ch_speed * np.cos(ch_dir)  # north component
            # Counter-clockwise gyre — a ring of tangential flow mid-bay.
            dx, dy = gx - 0.5, gy - 0.42
            r = np.hypot(dx, dy)
            if r > 1e-6:
                gg = np.exp(-((r - 0.16) / 0.09) ** 2)
                u += gg * -dy / r
                v += gg * dx / r
            speed[row, col] = min(2.2, np.hypot(u, v))
            direction[row, col] = (np.arctan2(u, v) / D2R + 360) % 360
    gf = [
        ["surfaceCurrentSpeed", "Surface current speed", "knots", str(FILL), "H5T_FLOAT", "0.00", "", "geSemiInterval"],
        ["surfaceCurrentDirection", "Surface current dir", "arc-degree", str(FILL), "H5T_FLOAT", "0.0", "359.9", "closedInterval"],
    ]
    path = os.path.join(OUT, "synthetic-currents.h5")
    with h5py.File(path, "w", libver="earliest") as f:
        f.attrs["productSpecification"] = "INT.IHO.S-111.1.2"
        f.attrs["horizontalCRS"] = np.int32(4326)
        f.attrs["surfaceCurrentDepth"] = np.float32(-2.0)
        _write_dcf2(f, "SurfaceCurrent", N_LAT, N_LON, ORIGIN[0], ORIGIN[1], SPACING[0], SPACING[1],
                    [("surfaceCurrentSpeed", speed[::-1, :]), ("surfaceCurrentDirection", direction[::-1, :])], gf)
    valid = speed != FILL
    return path, int(valid.sum()), float(speed[valid].max())


def currents_south():
    """The currents field on a DIFFERENT grid — 23x29 rather than 32x48, placed south of
    it and slightly overlapping in longitude.

    The point is the SHAPE, not the physics: two mosaic domains must differ in valid-cell
    COUNT and in grid-uv origin layout, or a gate cannot tell "each region reads its own
    arrow state" from "they all read region 0's" (#1458). Prime-ish dimensions so the
    count is unlikely to coincide with anything.
    """
    N_LON, N_LAT = 23, 29
    ORIGIN = (-76.30, 34.90)
    SPACING = (0.031, 0.047)
    FILL = -9999.0
    D2R = np.pi / 180.0
    speed = np.zeros((N_LAT, N_LON), dtype=np.float32)      # NORTH-UP: row 0 = north
    direction = np.zeros((N_LAT, N_LON), dtype=np.float32)
    for row in range(N_LAT):
        gy = 1 - row / (N_LAT - 1)
        # A different coast shape, so the nodata mask is not a rescaling of the first's.
        west_land = 0.08 + 0.10 * np.sin(gy * 2.3 + 0.7)
        east_land = 0.12 + 0.05 * np.cos(gy * 6.1)
        for col in range(N_LON):
            gx = col / (N_LON - 1)
            if gx < west_land or gx > 1 - east_land:
                speed[row, col] = FILL
                direction[row, col] = FILL
                continue
            # A single southeastward jet, banded across the speed range so the arrows
            # exercise more than one catalogue colour.
            ch = max(0.0, 1 - abs(gx - 0.45) / 0.55) ** 1.2
            sp = 0.4 + 2.6 * ch * (0.5 + 0.5 * np.sin(gy * 3.1))
            speed[row, col] = min(3.4, sp)
            direction[row, col] = (135 + 30 * np.sin(gy * 2.0)) % 360
    gf = [
        ["surfaceCurrentSpeed", "Surface current speed", "knots", str(FILL), "H5T_FLOAT", "0.00", "", "geSemiInterval"],
        ["surfaceCurrentDirection", "Surface current dir", "arc-degree", str(FILL), "H5T_FLOAT", "0.0", "359.9", "closedInterval"],
    ]
    path = os.path.join(OUT, "synthetic-currents-south.h5")
    with h5py.File(path, "w", libver="earliest") as f:
        f.attrs["productSpecification"] = "INT.IHO.S-111.1.2"
        f.attrs["horizontalCRS"] = np.int32(4326)
        f.attrs["surfaceCurrentDepth"] = np.float32(-2.0)
        _write_dcf2(f, "SurfaceCurrent", N_LAT, N_LON, ORIGIN[0], ORIGIN[1], SPACING[0], SPACING[1],
                    [("surfaceCurrentSpeed", speed[::-1, :]), ("surfaceCurrentDirection", direction[::-1, :])], gf)
    valid = speed != FILL
    return path, int(valid.sum()), float(speed[valid].max())


def main():
    os.makedirs(OUT, exist_ok=True)
    for fn in (bathymetry, currents, currents_south):
        path, valid, mx = fn()
        print(f"wrote {os.path.relpath(path):44s} {os.path.getsize(path):6d} B  "
              f"valid={valid} max={mx:.2f}")


if __name__ == "__main__":
    main()
