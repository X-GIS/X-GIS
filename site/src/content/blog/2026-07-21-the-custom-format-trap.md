---
title: 'The custom format trap: we set aside .xgvt, then shipped .xgcov'
description: 'A coverage feature was built on .xgcov — an in-house binary for gridded data. The same two forces that made us step back from a custom vector-tile format (.xgvt) to PMTiles/MVT — no ecosystem, no HTTP-range streaming — apply verbatim to .xgcov. The rule: before inventing a binary interchange format, a standard almost always already exists (PMTiles for vector, COG for raster/coverage), and the best case is to read that standard IN PLACE via range requests, converting only non-web-native sources server-side to a standard, never to a bespoke blob.'
date: 2026-07-21T15:00:00Z
tags: ['architecture', 'formats', 'web', 'single-authority', 'cog', 'pmtiles']
lang: en
draft: false
---

We wired NOAA S-111 surface currents onto the globe (#1272), and the render
side rode `.xgcov` — the in-house "X-GIS Coverage" binary that #1158 introduced
for S-100 gridded data: a `XCOV` magic, a JSON header, per-band deflate blocks,
a tidy zero-dependency 200-line decoder. It was already landed, already tested.
The work was just to extend it.

One question stopped the whole thing: **why does this format exist?**

## We already ran this experiment

We had built this exact thing before, one layer up. A custom vector-tile format
— call it `.xgvt` — was going to be _our_ tile container. We stepped back from
it to PMTiles + MVT for two reasons that had nothing to do with how elegant the
bytes were:

1. **Compatibility.** A bespoke format has no ecosystem. Nobody else writes it,
   no tool reads it, and none of the data already sitting on the web is in it.
   The moment you invent a container, every producer must run _your_ converter
   and every consumer must link _your_ decoder. PMTiles/MVT let a user point at
   an archive that GDAL/tippecanoe made and a hundred other tools understand.

2. **Web real-time.** A single self-contained blob does not stream. The web way
   to move a planet of data through a browser is HTTP **range requests** against
   a tiled, pyramided file — fetch the tiles the viewport needs at the zoom it
   needs, evict the rest, never hold the whole thing. PMTiles is built for
   exactly that. A blob is download-all-or-nothing.

`.xgcov` fails **both** tests, verbatim. It is a bespoke container (only our
converter emits it) and a single blob (no directory, no range layout). Every
argument we had made _for_ it — the tiny zero-dep decoder, the S-100 semantics
in the header, the exact CPU value readback — is the same class of argument the
`.xgvt` decision had already weighed and found insufficient. We ship pmtiles,
proj4, and pbf as dependencies already; "it avoids a dependency" was never worth
forking a format.

## The standard was already there — and better

For gridded/raster data the "PMTiles of the raster world" is **COG**
(Cloud-Optimized GeoTIFF): internally tiled, overview-pyramided, its IFD ordered
for HTTP range, produced by `gdal_translate`, read in-browser by `geotiff.js`,
served by TiTiler, consumed by everything. It stores full-precision float, so
exact readback survives — **per tile**, which our single blob could not do. It
carries metadata in tags. It does everything `.xgcov` did and solves the two
problems that had killed `.xgvt`.

## The deeper cut: read it in place

The trap has a second floor. Even converting to a _standard_ is the wrong
instinct when the source is already a web-readable standard. If a COG is sitting
on static hosting, the right move is to **range-read it where it lives** —
`geotiff.js` fetches only the tiles and overviews the current view needs. No
conversion, no re-hosting, no second copy. Re-baking a COG into `.xgcov` (or into
another COG) is pure waste.

Conversion earns its place in exactly one spot: a source that is genuinely _not_
web-native (raw HDF5, GRIB2, NetCDF that cannot be efficiently range-read in the
browser, or that is CORS-blocked). Even there, it runs **server-side** and it
targets a **standard** (COG), so the browser still ends up range-reading a
standard in place. The custom format appears nowhere in the chain.

## What was actually worth keeping

Almost none of the value lived in the format. The HDF5→grid reader (the ingest),
the grid→texture→colour-ramp renderer, the particle packer, the demos — all of
it is format-agnostic and survives any wire-format choice. The format was the one
part that should not have been built, and the one part we were about to build
_more_ on.

## The rule

Before inventing a binary interchange format, stop: a standard almost certainly
already covers it — **PMTiles** for vector tiles, **COG** for raster/coverage
grids, GeoJSON for features. Reach for the standard, and prefer to read it **in
place** via range requests over converting anything. Convert only a non-web-native
source, only server-side, and only _to_ a standard — never to a bespoke blob. The
zero-dependency-decoder and custom-semantics arguments do not clear this bar; we
have now paid for that lesson twice (`.xgvt`, then `.xgcov`). If you find yourself
writing a magic number, you are probably about to lose an ecosystem.
