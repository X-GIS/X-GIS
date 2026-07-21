#!/usr/bin/env python3
# ═══ HDF5 golden-fixture generator for the in-house S-100 reader (#1158 GAP-1 INC-A) ═══
#
# Emits the TINY committed .h5 corpus + h5py-read JSON goldens that pin the
# in-house DataView HDF5 subset reader (data/src/hdf5/). h5py is the OFFLINE
# ORACLE (never linked into the shipped reader); this script is the regeneration
# route, run from a throwaway venv:
#
#   python3 -m venv /tmp/h5venv && /tmp/h5venv/bin/pip install h5py
#   /tmp/h5venv/bin/python data/tools/gen-h5-fixtures.py
#
# Every emitted .h5 targets exactly the reader's SUBSET (superblock v0/v2; object
# headers v1/v2; symbol-table + compact-link groups; contiguous + v1-btree chunked;
# deflate + shuffle; fixed-point / IEEE-float / compound datatypes) or is a NEGATIVE
# that MUST fail loudly (superblock v3, fletcher32, vlen string, big-endian,
# dense-attribute storage). Attribute spellings copied VERBATIM from the real NOAA
# S-102 Ed 3.0.0 cell (BathymetryCoverage.01 — gridOriginLongitude / gridSpacing-
# Latitudinal / numPointsLongitudinal / startSequence / sequencingRule.*), so the
# synthetic S-102 shape matches the corpus the reader must ingest.
#
# The .h5 bytes + the JSON goldens are the committed differential authority; NO
# NOAA-derived bytes or value dumps are committed (licence to-verify).

import json
import os
import numpy as np
import h5py

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "hdf5", "__fixtures__")
os.makedirs(OUT, exist_ok=True)


def superblock_version(path):
    """Read byte 8 of the file = the superblock version (after the 8-byte sig)."""
    with open(path, "rb") as fh:
        head = fh.read(16)
    assert head[:8] == b"\x89HDF\r\n\x1a\n", f"{path}: not an HDF5 file"
    return head[8]


def jdump(name, obj):
    with open(os.path.join(OUT, name + ".json"), "w") as fh:
        json.dump(obj, fh, indent=1, sort_keys=True)


def grid(nlat, nlon, base=0.0, step=1.0):
    """Row-major [lat][lon] test grid; distinct value per cell so a south-flip or a
    transpose bug is caught. Stored SOUTH-ROW-FIRST (row 0 = grid origin = south),
    exactly like the S-100 native layout."""
    a = np.zeros((nlat, nlon), dtype=np.float32)
    for i in range(nlat):
        for j in range(nlon):
            a[i, j] = base + step * (i * nlon + j)
    return a


# ── S-102 attribute spellings, verbatim from the real NOAA cell ────────────────
def write_s102_shape(g, nlat, nlon, origin_lon, origin_lat, d_lon, d_lat,
                     depth, uncertainty, fill=1e6, pad=False,
                     chunks=None, shuffle=False, gzip=False):
    """Build Root→<container>→<container>.01→Group_001/values + Group_F with the
    S-102 spellings. `pad`=True emits a padded compound (offsets [0,8], itemsize 16)
    to exercise member-offset reads that are NOT packed."""
    cont = g.create_group("BathymetryCoverage")
    cont.attrs["dataCodingFormat"] = np.uint8(2)
    cont.attrs["dimension"] = np.uint8(2)
    cont.attrs["numInstances"] = np.uint8(1)
    cont.attrs["sequencingRule.scanDirection"] = "Easting, Northing"
    cont.attrs["sequencingRule.type"] = np.uint8(1)

    inst = cont.create_group("BathymetryCoverage.01")
    inst.attrs["gridOriginLongitude"] = np.float64(origin_lon)
    inst.attrs["gridOriginLatitude"] = np.float64(origin_lat)
    inst.attrs["gridSpacingLongitudinal"] = np.float64(d_lon)
    inst.attrs["gridSpacingLatitudinal"] = np.float64(d_lat)
    inst.attrs["numPointsLongitudinal"] = np.uint32(nlon)
    inst.attrs["numPointsLatitudinal"] = np.uint32(nlat)
    inst.attrs["startSequence"] = "0,0"
    inst.attrs["numGRP"] = np.uint8(1)
    # outer-edge bbox = origin (SW cell CENTRE) ∓ spacing/2 … + n·spacing
    inst.attrs["westBoundLongitude"] = np.float32(origin_lon - d_lon / 2)
    inst.attrs["eastBoundLongitude"] = np.float32(origin_lon - d_lon / 2 + nlon * d_lon)
    inst.attrs["southBoundLatitude"] = np.float32(origin_lat - d_lat / 2)
    inst.attrs["northBoundLatitude"] = np.float32(origin_lat - d_lat / 2 + nlat * d_lat)

    grp = inst.create_group("Group_001")
    grp.attrs["timePoint"] = "10101T000000Z"
    if pad:
        dt = np.dtype({"names": ["depth", "uncertainty"],
                       "formats": ["<f4", "<f4"],
                       "offsets": [0, 8], "itemsize": 16})
    else:
        dt = np.dtype([("depth", "<f4"), ("uncertainty", "<f4")])
    vals = np.zeros((nlat, nlon), dtype=dt)
    vals["depth"] = depth
    vals["uncertainty"] = uncertainty
    kw = {}
    if chunks:
        kw["chunks"] = chunks
    if shuffle:
        kw["shuffle"] = True
    if gzip:
        kw["compression"] = "gzip"
        kw["compression_opts"] = 6
    grp.create_dataset("values", data=vals, **kw)

    # Group_F — the band metadata carrier; fillValue lives HERE (string form).
    # FIXED-length HDF5 strings (S-strings), NOT vlen: fixed strings + compound are
    # in the reader subset; vlen (class 9) is a hard error (neg_vlen). The real NOAA
    # file uses vlen Group_F, so the reader errors loudly on it — its local gate
    # reads GRID + geometry only (no Group_F). The committed synthetic corpus uses
    # fixed strings so the fillValue is readable in-subset end-to-end.
    gf = g.create_group("Group_F")
    S = "S16"  # fits 'closedInterval' (14) / 'geSemiInterval' (14) / '1000000'
    fdt = np.dtype([("code", S), ("name", S), ("uom.name", S),
                    ("fillValue", S), ("datatype", S), ("lower", S),
                    ("upper", S), ("closure", S)])
    rows = np.array([
        (b"depth", b"depth", b"metres", str(int(fill)).encode(), b"H5T_FLOAT", b"-14", b"11050", b"closedInterval"),
        (b"uncertainty", b"uncertainty", b"metres", str(int(fill)).encode(), b"H5T_FLOAT", b"0", b"", b"geSemiInterval"),
    ], dtype=fdt)
    gf.create_dataset("BathymetryCoverage", data=rows)
    gf.create_dataset("featureCode", data=np.array([b"BathymetryCoverage"], dtype=S))


def s102_root_attrs(f, vdatum=12):
    f.attrs["productSpecification"] = "INT.IHO.S-102.3.0.0"
    f.attrs["horizontalCRS"] = np.int32(4326)  # synthetic corpus is EPSG:4326 degrees
    f.attrs["verticalDatum"] = np.uint16(vdatum)
    f.attrs["verticalDatumReference"] = np.uint8(1)
    f.attrs["verticalCS"] = np.int32(6498)


# ── S-111 attribute spellings (surface currents; DCF2 sibling of the S-102 shape).
# Container/instance/Group_F names + the compound member names follow the S-111
# 1.2 spec (SurfaceCurrent / surfaceCurrentSpeed [knots] / surfaceCurrentDirection
# [arc-degrees, 0=true north CW]); the grid-geometry attributes are the shared
# S-100 part-10c spellings the reader already trusts for S-102. fill = -9999.0
# (the S-111 convention, vs S-102's 1e6) so the Group_F fill-value plumbing is
# exercised with a DIFFERENT sentinel than bathymetry.
def write_s111_shape(g, nlat, nlon, origin_lon, origin_lat, d_lon, d_lat,
                     speed, direction, fill=-9999.0):
    cont = g.create_group("SurfaceCurrent")
    cont.attrs["dataCodingFormat"] = np.uint8(2)
    cont.attrs["dimension"] = np.uint8(2)
    cont.attrs["numInstances"] = np.uint8(1)
    cont.attrs["sequencingRule.scanDirection"] = "Easting, Northing"
    cont.attrs["sequencingRule.type"] = np.uint8(1)

    inst = cont.create_group("SurfaceCurrent.01")
    inst.attrs["gridOriginLongitude"] = np.float64(origin_lon)
    inst.attrs["gridOriginLatitude"] = np.float64(origin_lat)
    inst.attrs["gridSpacingLongitudinal"] = np.float64(d_lon)
    inst.attrs["gridSpacingLatitudinal"] = np.float64(d_lat)
    inst.attrs["numPointsLongitudinal"] = np.uint32(nlon)
    inst.attrs["numPointsLatitudinal"] = np.uint32(nlat)
    inst.attrs["startSequence"] = "0,0"
    inst.attrs["numGRP"] = np.uint8(1)
    inst.attrs["westBoundLongitude"] = np.float32(origin_lon - d_lon / 2)
    inst.attrs["eastBoundLongitude"] = np.float32(origin_lon - d_lon / 2 + nlon * d_lon)
    inst.attrs["southBoundLatitude"] = np.float32(origin_lat - d_lat / 2)
    inst.attrs["northBoundLatitude"] = np.float32(origin_lat - d_lat / 2 + nlat * d_lat)

    grp = inst.create_group("Group_001")
    grp.attrs["timePoint"] = "20260721T000000Z"
    dt = np.dtype([("surfaceCurrentSpeed", "<f4"), ("surfaceCurrentDirection", "<f4")])
    vals = np.zeros((nlat, nlon), dtype=dt)
    vals["surfaceCurrentSpeed"] = speed
    vals["surfaceCurrentDirection"] = direction
    grp.create_dataset("values", data=vals)

    # Group_F band table — FIXED-length strings (reader subset; see the S-102
    # note above). S24 fits 'surfaceCurrentDirection' (23 chars).
    gf = g.create_group("Group_F")
    S = "S24"
    fdt = np.dtype([("code", S), ("name", S), ("uom.name", S),
                    ("fillValue", S), ("datatype", S), ("lower", S),
                    ("upper", S), ("closure", S)])
    rows = np.array([
        (b"surfaceCurrentSpeed", b"Surface current speed", b"knots",
         str(fill).encode(), b"H5T_FLOAT", b"0.00", b"", b"geSemiInterval"),
        (b"surfaceCurrentDirection", b"Surface current dir", b"arc-degree",
         str(fill).encode(), b"H5T_FLOAT", b"0.0", b"359.9", b"closedInterval"),
    ], dtype=fdt)
    gf.create_dataset("SurfaceCurrent", data=rows)
    gf.create_dataset("featureCode", data=np.array([b"SurfaceCurrent"], dtype=S))


def s111_root_attrs(f):
    f.attrs["productSpecification"] = "INT.IHO.S-111.1.2"
    f.attrs["horizontalCRS"] = np.int32(4326)
    f.attrs["surfaceCurrentDepth"] = np.float32(-2.0)
    f.attrs["depthTypeIndex"] = np.uint8(2)


def golden_s102(name, depth, uncertainty, nlat, nlon, origin_lon, origin_lat,
                d_lon, d_lat, fill=1e6, vdatum=12):
    """Golden = the h5py-read grid (SOUTH-FIRST, as stored) + geometry the reader
    must reproduce verbatim, plus the NORTH-UP flip readCoverageFromHdf5 must produce."""
    jdump(name, {
        "product": "s102",
        "nLon": nlon, "nLat": nlat,
        "origin": [origin_lon, origin_lat],
        "spacing": [d_lon, d_lat],
        "fillValue": fill,
        "verticalDatum": vdatum,
        "bandNames": ["depth", "uncertainty"],
        "depth_south_first": depth.tolist(),   # reader output (storage order)
        "depth_north_up": depth[::-1, :].tolist(),  # read-in-place output (row 0 = north)
        "uncertainty_south_first": uncertainty.tolist(),
    })


# ═══ 1. superblock v0 + symbol-table group + contiguous compound (packed) ═══════
def gen_sb_v0():
    path = os.path.join(OUT, "sb_v0_symtab.h5")
    nlat, nlon = 3, 4
    d = grid(nlat, nlon, base=10.0, step=1.0)
    d[0, 0] = 1e6  # one nodata cell (SW corner, south-first row 0)
    u = grid(nlat, nlon, base=0.1, step=0.01)
    with h5py.File(path, "w", libver="earliest") as f:
        s102_root_attrs(f)
        write_s102_shape(f, nlat, nlon, 5.0, 50.0, 0.5, 0.25, d, u, fill=1e6)
    assert superblock_version(path) == 0, superblock_version(path)
    golden_s102("sb_v0_symtab", d, u, nlat, nlon, 5.0, 50.0, 0.5, 0.25)
    return path


# ═══ 2. superblock v2 + compact link-message group ══════════════════════════════
def gen_sb_v2():
    path = os.path.join(OUT, "sb_v2_links.h5")
    nlat, nlon = 3, 4
    d = grid(nlat, nlon, base=100.0, step=2.0)
    u = grid(nlat, nlon, base=1.0, step=0.1)
    with h5py.File(path, "w", libver=("v108", "v108")) as f:
        s102_root_attrs(f)
        write_s102_shape(f, nlat, nlon, -122.0, 37.0, 0.1, 0.1, d, u, fill=1e6)
    assert superblock_version(path) == 2, superblock_version(path)
    golden_s102("sb_v2_links", d, u, nlat, nlon, -122.0, 37.0, 0.1, 0.1)
    return path


# ═══ 3. chunked + shuffle + gzip, partial edge chunks, PADDED compound ══════════
def gen_chunked_shuffle():
    path = os.path.join(OUT, "chunked_shuffle.h5")
    nlat, nlon = 3, 4  # 2×2 chunks over 3×4 → partial edge chunks on both axes
    d = grid(nlat, nlon, base=20.0, step=1.5)
    d[1, 2] = 1e6  # nodata inside a chunk
    u = grid(nlat, nlon, base=0.5, step=0.05)
    with h5py.File(path, "w", libver="earliest") as f:
        s102_root_attrs(f)
        write_s102_shape(f, nlat, nlon, 0.0, 0.0, 1.0, 1.0, d, u, fill=1e6,
                         pad=True, chunks=(2, 2), shuffle=True, gzip=True)
    assert superblock_version(path) == 0
    golden_s102("chunked_shuffle", d, u, nlat, nlon, 0.0, 0.0, 1.0, 1.0)
    return path


# ═══ 4. sparse — an UNWRITTEN chunk must fill from the fill value ════════════════
def gen_sparse():
    path = os.path.join(OUT, "sparse_chunk.h5")
    nlat, nlon = 4, 4  # 2×2 chunks → 4 chunks; write only 3, leave one hole
    with h5py.File(path, "w", libver="earliest") as f:
        s102_root_attrs(f)
        cont = f.create_group("BathymetryCoverage")
        cont.attrs["dataCodingFormat"] = np.uint8(2)
        cont.attrs["numInstances"] = np.uint8(1)
        inst = cont.create_group("BathymetryCoverage.01")
        inst.attrs["gridOriginLongitude"] = np.float64(0.0)
        inst.attrs["gridOriginLatitude"] = np.float64(0.0)
        inst.attrs["gridSpacingLongitudinal"] = np.float64(1.0)
        inst.attrs["gridSpacingLatitudinal"] = np.float64(1.0)
        inst.attrs["numPointsLongitudinal"] = np.uint32(nlon)
        inst.attrs["numPointsLatitudinal"] = np.uint32(nlat)
        inst.attrs["startSequence"] = "0,0"
        grp = inst.create_group("Group_001")
        dt = np.dtype([("depth", "<f4"), ("uncertainty", "<f4")])
        # fill_value on the dataset = the missing-chunk fill (777 sentinel here).
        # A compound fill must be a compound-typed scalar, not a bare tuple.
        fillv = np.array((777.0, 0.0), dtype=dt)
        ds = grp.create_dataset("values", shape=(nlat, nlon), dtype=dt,
                                chunks=(2, 2), fillvalue=fillv)
        block = np.zeros((2, 2), dtype=dt)
        for (ci, cj) in [(0, 0), (0, 1), (1, 0)]:
            block["depth"] = float(10 + ci * 10 + cj)
            ds[ci * 2:ci * 2 + 2, cj * 2:cj * 2 + 2] = block
        gf = f.create_group("Group_F")
        vstr = h5py.special_dtype(vlen=str)
        fdt = np.dtype([("code", vstr), ("name", vstr), ("uom.name", vstr),
                        ("fillValue", vstr), ("datatype", vstr), ("lower", vstr),
                        ("upper", vstr), ("closure", vstr)])
        gf.create_dataset("BathymetryCoverage", data=np.array([
            ("depth", "depth", "metres", "1000000", "H5T_FLOAT", "-14", "11050", "closedInterval"),
            ("uncertainty", "uncertainty", "metres", "1000000", "H5T_FLOAT", "0", "", "geSemiInterval"),
        ], dtype=fdt))
    assert superblock_version(path) == 0
    with h5py.File(path, "r") as f:
        d = f["BathymetryCoverage/BathymetryCoverage.01/Group_001/values"]["depth"][()]
    jdump("sparse_chunk", {
        "nLon": nlon, "nLat": nlat,
        "depth_south_first": d.tolist(),
        "missing_chunk_fill": 777.0,
    })
    return path


# ═══ 5. asymmetric grid — south-flip / valueAt / registration gate ══════════════
def gen_asym():
    path = os.path.join(OUT, "asym_southflip.h5")
    nlat, nlon = 2, 3  # asymmetric so a transpose OR a flip bug is caught
    d = np.array([[10.0, 11.0, 12.0],                # south-first: row 0 = SOUTH
                  [20.0, 21.0, 22.0]], dtype=np.float32)  # row 1 = NORTH
    d[0, 2] = 1e6  # nodata at SE
    u = np.array([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], dtype=np.float32)
    with h5py.File(path, "w", libver="earliest") as f:
        s102_root_attrs(f, vdatum=23)  # 23 = LAT
        write_s102_shape(f, nlat, nlon, 5.0, 50.0, 2.0, 1.0, d, u, fill=1e6)
    assert superblock_version(path) == 0
    golden_s102("asym_southflip", d, u, nlat, nlon, 5.0, 50.0, 2.0, 1.0, vdatum=23)
    return path


# ═══ 6. packed compound — member-offset read gate (offsets 0/4 itemsize 8) ══════
def gen_packed_compound():
    path = os.path.join(OUT, "packed_compound.h5")
    nlat, nlon = 2, 2
    d = grid(nlat, nlon, base=5.0, step=1.0)
    u = grid(nlat, nlon, base=9.0, step=1.0)
    with h5py.File(path, "w", libver="earliest") as f:
        s102_root_attrs(f)
        write_s102_shape(f, nlat, nlon, 0.0, 0.0, 1.0, 1.0, d, u, fill=1e6)
    assert superblock_version(path) == 0
    golden_s102("packed_compound", d, u, nlat, nlon, 0.0, 0.0, 1.0, 1.0)
    return path


# ═══ 7. S-111 surface currents — DCF2 sibling product (speed + direction) ═══════
def gen_s111():
    """Asymmetric 3×4 S-111 cell: distinct speed/direction per cell + one nodata
    cell in BOTH bands, -9999 fill (not S-102's 1e6), Chesapeake-ish origin. Gates
    that the DCF2 reader is product-agnostic end-to-end: container discovery by
    dataCodingFormat, the 2-member compound decode, the Group_F fill for a
    DIFFERENT feature name, and product detection from productSpecification."""
    path = os.path.join(OUT, "s111_dcf2.h5")
    nlat, nlon = 3, 4
    speed = grid(nlat, nlon, base=0.2, step=0.1)          # 0.2 … 1.3 kn
    direction = grid(nlat, nlon, base=10.0, step=25.0)    # 10 … 285°
    speed[1, 1] = -9999.0
    direction[1, 1] = -9999.0
    with h5py.File(path, "w", libver="earliest") as f:
        s111_root_attrs(f)
        write_s111_shape(f, nlat, nlon, -76.4, 37.5, 0.1, 0.05, speed, direction)
    assert superblock_version(path) == 0, superblock_version(path)
    jdump("s111_dcf2", {
        "product": "s111",
        "nLon": nlon, "nLat": nlat,
        "origin": [-76.4, 37.5],
        "spacing": [0.1, 0.05],
        "fillValue": -9999.0,
        "bandNames": ["surfaceCurrentSpeed", "surfaceCurrentDirection"],
        "bandUnits": ["knots", "arc-degree"],
        "speed_south_first": speed.tolist(),
        "speed_north_up": speed[::-1, :].tolist(),
        "direction_south_first": direction.tolist(),
    })
    return path


# ═══ NEGATIVES — each MUST fail loudly, naming the construct ═════════════════════
def gen_neg_v3():
    path = os.path.join(OUT, "neg_v3_latest.h5")
    with h5py.File(path, "w", libver="latest") as f:
        s102_root_attrs(f)
        write_s102_shape(f, 3, 4, 0.0, 0.0, 1.0, 1.0, grid(3, 4), grid(3, 4))
    assert superblock_version(path) == 3, superblock_version(path)
    return path


def gen_neg_fletcher32():
    path = os.path.join(OUT, "neg_fletcher32.h5")
    with h5py.File(path, "w", libver="earliest") as f:
        f.create_dataset("values", data=grid(4, 4), chunks=(2, 2), fletcher32=True)
    return path


def gen_neg_vlen():
    path = os.path.join(OUT, "neg_vlen.h5")
    with h5py.File(path, "w", libver="earliest") as f:
        f.create_dataset("s", data=np.array(["ab", "cde"], dtype=h5py.special_dtype(vlen=str)))
    return path


def gen_neg_bigendian():
    path = os.path.join(OUT, "neg_bigendian.h5")
    with h5py.File(path, "w", libver="earliest") as f:
        f.create_dataset("values", data=grid(3, 3).astype(">f4"))
    return path


def gen_neg_dense_attr():
    # Force DENSE attribute storage (fractal heap): many attrs on a group. Use v108
    # (superblock v2, object-header v2) — NOT 'latest' — so the reader clears the
    # superblock and fails SPECIFICALLY on the fractal-heap dense storage, naming it.
    path = os.path.join(OUT, "neg_dense_attr.h5")
    with h5py.File(path, "w", libver=("v108", "v108")) as f:
        g = f.create_group("g")
        for i in range(64):
            g.attrs["attr_%03d" % i] = np.int32(i)
        f.create_dataset("values", data=grid(2, 2))
    return path


# ═══ LOCAL-ONLY: dump the real NOAA cell's differential golden (NEVER committed) ══
def gen_noaa_local_golden():
    """If the real NOAA cell is present under __local__ (gitignored), dump a small
    differential golden the skipIf reader test compares against. NO NOAA bytes or
    dumps are committed — this file lives under __local__/ which is fully gitignored."""
    local = os.path.join(HERE, "..", "src", "hdf5", "__local__")
    src = os.path.join(local, "noaa-s102.h5")
    if not os.path.exists(src):
        return
    with h5py.File(src, "r") as f:
        d = f["BathymetryCoverage/BathymetryCoverage.01/Group_001/values"]["depth"][()]
    nlat, nlon = d.shape
    valid = d[d < 1e5]
    samples = [[r, c, float(d[r, c])] for (r, c) in
               [(0, 0), (1000, 1200), (nlat // 2, nlon // 2), (nlat - 1, nlon - 1), (500, 500)]]
    with open(os.path.join(local, "noaa-golden.json"), "w") as fh:
        json.dump({"nLat": int(nlat), "nLon": int(nlon), "samples": samples,
                   "validCount": int(valid.size), "validMin": float(valid.min()),
                   "validMax": float(valid.max())}, fh)
    print("  (local NOAA golden dumped → __local__/noaa-golden.json — gitignored)")


def main():
    made = []
    for fn in (gen_sb_v0, gen_sb_v2, gen_chunked_shuffle, gen_sparse, gen_asym,
               gen_packed_compound, gen_s111, gen_neg_v3, gen_neg_fletcher32,
               gen_neg_vlen, gen_neg_bigendian, gen_neg_dense_attr):
        p = fn()
        made.append((os.path.basename(p), os.path.getsize(p), superblock_version(p)))
    gen_noaa_local_golden()
    print("fixture                       bytes  sbver")
    for name, sz, sb in made:
        print(f"  {name:28s} {sz:6d}   v{sb}")
    print(f"\nwrote {len(made)} .h5 + goldens → {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
