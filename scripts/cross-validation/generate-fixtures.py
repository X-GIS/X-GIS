"""
Cross-validation fixture generator.

Produces reference JSON values using INDEPENDENT reference implementations:
  - pyproj      : projection transforms (Mercator, Natural Earth, etc.)
  - mercantile  : slippy-map tile math (lon/lat ↔ tile x/y, tile bounds)
  - shapely     : geometric operations (area, intersection, containment)

The generated fixture is committed to the repo; X-GIS TypeScript tests
load it and compare their own implementations against these reference
values. When regenerating, run via:

    cd scripts/cross-validation
    uv run generate-fixtures.py

The fixture lives at runtime/src/__tests__/cross-validation.fixture.json.
Regenerate whenever a projection/tile formula intentionally changes.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import mercantile
import pyproj
from shapely.geometry import Polygon, shape


# Script-relative output path — writes to the runtime test fixture.
SCRIPT_DIR = Path(__file__).parent
OUT = (SCRIPT_DIR / ".." / ".." / "runtime" / "src" / "__tests__"
       / "cross-validation.fixture.json").resolve()


# ════════════════════════════════════════════════════════════════════
# 1. Projection reference — pyproj
#
# EPSG:3857 is the standard Web Mercator. Other "natural earth"
# projections are named by pyproj as "natearth"/"natearth2".
# ════════════════════════════════════════════════════════════════════

mercator = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
mercator_inv = pyproj.Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)

# Reference (lon, lat) sample grid — 9×9 covering the globe minus the
# exact Mercator pole singularity.
LONS = [-170, -120, -60, -10, 0, 10, 60, 120, 170]
LATS = [-80, -60, -30, -10, 0, 10, 30, 60, 80]

projection_samples = []
for lon in LONS:
    for lat in LATS:
        x, y = mercator.transform(lon, lat)
        projection_samples.append({"lon": lon, "lat": lat, "mercX": x, "mercY": y})

# Inverse test: from Mercator back to lon/lat.
mercator_inverse_samples = []
for s in projection_samples:
    lon, lat = mercator_inv.transform(s["mercX"], s["mercY"])
    mercator_inverse_samples.append({"mercX": s["mercX"], "mercY": s["mercY"],
                                     "lon": lon, "lat": lat})


# ════════════════════════════════════════════════════════════════════
# 2. Tile math reference — mercantile
#
# mercantile is the canonical slippy-map tile implementation used by
# Mapbox, Mapnik, etc. Reference for (lon, lat, zoom) → (x, y) tile
# and for tile bounds (lon/lat).
# ════════════════════════════════════════════════════════════════════

# Known-location tile queries. Each produces mercantile's canonical
# tile at each test zoom.
TILE_QUERIES = [
    {"label": "Paris",     "lon": 2.3522,    "lat": 48.8566},
    {"label": "Tokyo",     "lon": 139.6917,  "lat": 35.6895},
    {"label": "NewYork",   "lon": -74.0060,  "lat": 40.7128},
    {"label": "Sydney",    "lon": 151.2093,  "lat": -33.8688},
    {"label": "Equator0",  "lon": 0.0,       "lat": 0.0},
    {"label": "Polar80",   "lon": 0.0,       "lat": 80.0},
]

tile_samples = []
for q in TILE_QUERIES:
    for z in [0, 3, 5, 8, 10, 14, 18, 22]:
        t = mercantile.tile(q["lon"], q["lat"], z)
        b = mercantile.bounds(t)
        tile_samples.append({
            "label": q["label"],
            "lon": q["lon"], "lat": q["lat"], "zoom": z,
            "tileX": t.x, "tileY": t.y, "tileZ": t.z,
            "boundsWest": b.west, "boundsSouth": b.south,
            "boundsEast": b.east, "boundsNorth": b.north,
        })


# ════════════════════════════════════════════════════════════════════
# 3. Polygon area / containment / clipping — shapely
#
# Shapely uses GEOS underneath, the de-facto reference for 2-D GIS
# geometry. We cross-check our Sutherland-Hodgman clipper and fullCover
# area test against GEOS.
# ════════════════════════════════════════════════════════════════════

# A world-covering polygon (matches test fixture in the TS suite).
WORLD_RING = [(-170, -80), (170, -80), (170, 80), (-170, 80), (-170, -80)]

# Tile bounds at a few zooms to clip against.
CLIP_SAMPLES = []
for z in [3, 5, 8, 10, 14]:
    # Use a tile near (0, 0).
    tx = 2 ** (z - 1)
    ty = 2 ** (z - 1)
    t = mercantile.Tile(tx, ty, z)
    b = mercantile.bounds(t)
    tile_poly = Polygon([
        (b.west, b.south), (b.east, b.south),
        (b.east, b.north), (b.west, b.north),
        (b.west, b.south),
    ])
    world_poly = Polygon(WORLD_RING)

    # Containment: does the world polygon fully cover this tile?
    contains = world_poly.contains(tile_poly)
    # Intersection area vs tile area (fullCover ratio used by compiler's
    # compileSingleTile fullCover detection).
    inter = world_poly.intersection(tile_poly)
    CLIP_SAMPLES.append({
        "zoom": z,
        "tileX": tx, "tileY": ty,
        "tileWest": b.west, "tileSouth": b.south,
        "tileEast": b.east, "tileNorth": b.north,
        "tileArea": tile_poly.area,  # in (lon×lat) deg²
        "interArea": inter.area,
        "fullyCovered": contains,  # True iff the world polygon contains the tile
    })


# ════════════════════════════════════════════════════════════════════
# 4. Specific reference values — published / documented
#
# These are values that come from GIS standards (EPSG, OGC) or
# papers (Šavrič 2015), not from libraries. Cross-checking our
# implementation against library-computed values AND against
# published values.
# ════════════════════════════════════════════════════════════════════

# EPSG:3857 spec points — all exact per the standard.
reference_constants = {
    "mercator_at_zero": {"lon": 0, "lat": 0, "expectedX": 0.0, "expectedY": 0.0},
    # At lat=85.05112877980659 the Mercator Y = π×R; this is EPSG:3857's pole.
    "mercator_pole_x": {"lon": 180, "lat": 0,
                        "expectedX": 20037508.342789244, "expectedY": 0.0},
    # Earth radius per EPSG:3857 (WGS84 sphere approximation).
    "earth_radius_m": 6378137.0,
    "pi_times_R": 20037508.342789244,
}


# ════════════════════════════════════════════════════════════════════
# 5. Other projections (forward + inverse round-trip) — pyproj
#
# X-GIS implements 7 projections. Mercator is cross-checked above via
# EPSG:3857. Here we add pyproj references for 5 more. Oblique Mercator
# is intentionally skipped: X-GIS's implementation uses a custom
# sphere-rotation-then-Mercator formula that doesn't map 1:1 to pyproj's
# parameterization; its correctness is verified by intra-repo CPU/WGSL
# consistency tests instead.
#
# All projections use R = 6378137 (matches EARTH_RADIUS in projection.ts).
# natearth2 is the Šavrič 2015 polynomial variant used by X-GIS (not
# Patterson's natearth).
# ════════════════════════════════════════════════════════════════════

# Ortho/AEQD/Stereo are family-parameterized — pick a specific center
# that matches the default in projection.ts (lon=0, lat=20).
OTHER_PROJECTIONS = {
    "equirectangular":       "+proj=eqc    +R=6378137 +lon_0=0",
    "natural_earth":         "+proj=natearth2 +R=6378137 +lon_0=0",
    "orthographic":          "+proj=ortho  +R=6378137 +lon_0=0 +lat_0=20",
    "azimuthal_equidistant": "+proj=aeqd   +R=6378137 +lon_0=0 +lat_0=20",
    "stereographic":         "+proj=stere  +R=6378137 +lon_0=0 +lat_0=20",
}

projection_samples_by_name: dict[str, list[dict]] = {}
for pname, crs in OTHER_PROJECTIONS.items():
    fwd = pyproj.Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    inv = pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    samples: list[dict] = []
    for lon in LONS:
        for lat in LATS:
            x, y = fwd.transform(lon, lat)
            if not (math.isfinite(x) and math.isfinite(y)):
                continue  # ortho back-face, aeqd antipode, etc.
            rlon, rlat = inv.transform(x, y)
            samples.append({
                "lon": lon, "lat": lat,
                "x": x, "y": y,
                "roundLon": rlon, "roundLat": rlat,
            })
    projection_samples_by_name[pname] = samples


# ════════════════════════════════════════════════════════════════════
# 6. Real-data tile feature-count cross-check — countries.geojson
#
# Load the same Natural Earth countries file the playground uses. For
# each slippy-map tile at z=2 and z=3, count how many country polygons
# intersect the tile's lon/lat bounds (shapely). X-GIS's compiler
# produces a per-tile `featureCount` which must agree.
# ════════════════════════════════════════════════════════════════════

GEOJSON_PATH = (SCRIPT_DIR / ".." / ".." / "playground" / "public"
                / "data" / "countries.geojson").resolve()

with GEOJSON_PATH.open(encoding="utf-8") as f:
    countries_gj = json.load(f)

country_geoms: list[dict] = []
for feat in countries_gj["features"]:
    try:
        g = shape(feat["geometry"])
        if not g.is_valid:
            g = g.buffer(0)  # GEOS canonical fix for self-intersecting rings
        country_geoms.append({
            "name": (feat.get("properties") or {}).get("name", "?"),
            "geom": g,
        })
    except Exception:  # noqa: BLE001 — any parse failure is a skip
        continue

tile_feature_counts: list[dict] = []
for z in [2, 3]:
    n = 2 ** z
    for tx in range(n):
        for ty in range(n):
            t = mercantile.Tile(tx, ty, z)
            b = mercantile.bounds(t)
            tile_poly = Polygon([
                (b.west, b.south), (b.east, b.south),
                (b.east, b.north), (b.west, b.north),
                (b.west, b.south),
            ])
            # Use "has non-zero intersection area" (not just `intersects`)
            # — shapely.intersects is True even for shared-boundary
            # touches, but X-GIS's clipper only emits triangles for
            # actual 2D overlap. Matching on area > 0 aligns with the
            # clipper's semantics.
            count = 0
            for c in country_geoms:
                if not c["geom"].intersects(tile_poly):
                    continue
                inter = c["geom"].intersection(tile_poly)
                if inter.area > 1e-12:  # deg² — excludes line/point touches
                    count += 1
            tile_feature_counts.append({
                "z": z, "x": tx, "y": ty,
                "west": b.west, "south": b.south,
                "east": b.east, "north": b.north,
                "featureCount": count,
            })


# ════════════════════════════════════════════════════════════════════
# 7. Per-country bounding boxes — shapely.bounds on countries.geojson
#
# Cross-checks X-GIS's per-feature bbox computation against GEOS.
# Stable-enough countries (no disputed-border ambiguity at 10m admin
# resolution): France (mainland + overseas), Japan (archipelago),
# Brazil, Australia, USA (spans antimeridian).
# ════════════════════════════════════════════════════════════════════

BBOX_COUNTRIES = ["France", "Japan", "Brazil", "Australia",
                  "United States of America"]
country_bboxes: list[dict] = []
for name in BBOX_COUNTRIES:
    cp = next((c for c in country_geoms if c["name"] == name), None)
    if cp is None:
        continue
    w, s, e, nbnd = cp["geom"].bounds
    country_bboxes.append({
        "name": name,
        "west": w, "south": s, "east": e, "north": nbnd,
    })


# ════════════════════════════════════════════════════════════════════
# Package everything as one JSON fixture.
# ════════════════════════════════════════════════════════════════════

fixture = {
    "_meta": {
        "generator": "scripts/cross-validation/generate-fixtures.py",
        "pyproj": pyproj.__version__,
        "mercantile": mercantile.__version__,
        "shapely": __import__("shapely").__version__,
    },
    "mercator_forward": projection_samples,
    "mercator_inverse": mercator_inverse_samples,
    "tile_math": tile_samples,
    "polygon_clip_contains": CLIP_SAMPLES,
    "projections": projection_samples_by_name,
    "tile_feature_counts": tile_feature_counts,
    "country_bboxes": country_bboxes,
    "constants": reference_constants,
}


OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", encoding="utf-8") as f:
    json.dump(fixture, f, indent=2)

print(f"Fixture written: {OUT}")
print(f"  mercator_forward:    {len(projection_samples)} samples")
print(f"  mercator_inverse:    {len(mercator_inverse_samples)} samples")
print(f"  tile_math:           {len(tile_samples)} samples")
print(f"  polygon_clip:        {len(CLIP_SAMPLES)} samples")
for pname, samples in projection_samples_by_name.items():
    print(f"  {pname:<22}  {len(samples)} samples")
print(f"  tile_feature_counts: {len(tile_feature_counts)} tiles "
      f"({len(country_geoms)} countries loaded)")
print(f"  country_bboxes:      {len(country_bboxes)} countries")
