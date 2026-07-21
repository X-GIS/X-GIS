---
title: 'The custom format trap: we set aside .xgvt, then shipped .xgcov'
description: 'A coverage feature was built on .xgcov — an in-house binary for gridded data. But the NOAA source is HDF5 (an IHO S-100 standard) and we already owned a reader for it, then transcoded it into a house blob anyway — the same mistake that made us step back from a custom vector-tile format (.xgvt): a bespoke container loses the ecosystem and HTTP-range streaming. The distinction that matters: a READER for a standard (our HDF5 reader, geotiff.js, pmtiles) is legitimate; TRANSCODING a standard into a house blob is the mistake. The rule: read whichever standard the data is already in (HDF5/NetCDF for scientific grids, COG for imagery, PMTiles for vector) IN PLACE via range requests; convert only a source that truly cannot be read as-is, server-side, only to a standard, never to a bespoke blob.'
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

## The standard was already there — and it was the `.h5` in our hand

Here is the part that makes `.xgcov` indefensible rather than merely redundant.
The NOAA S-111 file is **HDF5** — an IHO S-100 product, the international standard
NOAA actually publishes. We had also already written an HDF5 reader for it. So the
data arrived in a standard, and we owned a working reader for that standard, and
then we _transcoded it into a house blob anyway_. The `.xgcov` step converts a
standard nobody has to be taught into a format only we understand — pure loss,
zero gain.

The distinction we had blurred is the whole lesson:

- **A reader for a standard format is legitimate and necessary** — our HDF5
  reader, `geotiff.js` for COG, `pmtiles`-js for PMTiles. That is not "inventing a
  format"; it is speaking one the world already speaks.
- **Transcoding a standard into a bespoke container is the mistake** — `.xgcov`.
  It is the step that loses the ecosystem and buys nothing.

(My own first instinct here was wrong in an instructive way: I reached for COG
"the raster standard" as the answer. But COG is the standard for georeferenced
_imagery_; the standard for _this_ data is HDF5/S-100. Converting HDF5→COG would
have been the same pointless transcode wearing a more respectable name. The
domain picks the standard — HDF5/NetCDF for scientific grids, COG for imagery,
PMTiles for vector tiles, GeoJSON for features — and you read whichever one the
data is already in.)

## The deeper cut: read it in place

The trap has a second floor. Even transcoding to _another standard_ is the wrong
instinct when the source is already in a range-readable standard. HDF5 is
range-readable — its superblock → b-tree → chunk layout is exactly what our reader
already walks, and lazy HTTP-range variants (h5wasm and friends) prove a browser
can pull just the chunks a viewport needs without downloading the file. So the
move is to **read the `.h5` where it lives**, on demand, and feed the grid to the
renderer. No `.xgcov`, no COG, no second copy.

Conversion earns its place only when the source genuinely cannot be served or
read as-is — and even then it is a **server-side** step that targets a
**standard**, so the browser still range-reads a standard in place. A bespoke
container appears nowhere in the chain, ever.

## What was actually worth keeping

Almost none of the value lived in the format. The HDF5 reader (the ingest, a
reader for a _standard_ — keep it, make it range-capable), the grid→texture→colour
-ramp renderer, the particle packer, the demos — all format-agnostic, all survive.
The one part that should not have existed was `.xgcov`, and it was the one part we
were about to build _more_ on.

## The rule

Before inventing a binary interchange format, stop — the data is almost certainly
already in a standard, and the domain names which one: **HDF5 / NetCDF** for
scientific gridded data (S-100, NOAA model output), **COG** for georeferenced
imagery/raster, **PMTiles** for vector tiles, GeoJSON for features. Write (or
reuse) a _reader_ for that standard, and prefer to read it **in place** via range
requests over converting anything. Convert only a source that truly cannot be
read as-is, only server-side, and only _to_ a standard — never into a house blob.
The zero-dependency-decoder and custom-semantics arguments do not clear this bar;
we have now paid for that lesson twice (`.xgvt`, then `.xgcov`). If you are
writing a magic number, you are probably about to lose an ecosystem.
