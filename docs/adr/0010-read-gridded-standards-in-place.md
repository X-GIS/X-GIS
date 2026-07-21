# ADR-0010: Read gridded standards in place; deprecate `.xgcov` (the coverage transcode)

Status: Accepted — the `.xgcov` removal + read-in-place ingest landed in #1279; the
range-capable (HTTP-range / lazy-chunk) reader remains follow-up work.
Date: 2026-07-21

Supersedes the coverage wire-format decision in
`docs/architecture/design/s100-gap1-hdf5-coverage.md` (#1158), which introduced
`.xgcov`. That was not an ADR, so there is no prior ADR status to flip; this
record pins the reversal's rationale.

## Context

S-100 gridded coverage landed in #1158 on a house binary — **`.xgcov`** (`XCOV`
magic + JSON header + per-band deflate blocks, a single self-contained blob,
`data/src/coverage/format.ts`). The offline `s100-to-xgcov` converter (and later
the programmatic `s100ToXgcov`, `pipeline/src/hdf5/to-xgcov.ts`) transcodes an
S-100 HDF5 cell into it; the runtime `type: coverage` source decodes the blob.
Extending this for NOAA S-111 surface currents (#1272) forced the question:
**why does `.xgcov` exist at all?**

Two facts made the answer "it shouldn't":

1. **The source is already a standard.** NOAA S-111/S-102 are **HDF5** — IHO
   S-100 products, the international standard NOAA actually publishes (real cells
   confirmed on `noaa-s111-pds` / `noaa-s102-pds`, DCF2 HDF5). We also already own
   a from-scratch HDF5 reader for it (`pipeline/src/hdf5/`).
2. **We had already learned this.** A custom vector-tile format (`.xgvt`) was set
   aside for PMTiles/MVT because a bespoke container loses the ecosystem (no GDAL /
   tippecanoe / geotiff.js, none of the data already on the web) and web real-time
   (a blob has no HTTP-range streaming). `.xgcov` repeats it verbatim — full
   postmortem: `site/src/content/blog/2026-07-21-the-custom-format-trap.md`;
   rule in CLAUDE.md §12 "Architecture / data formats".

The blurred distinction is the whole point: **a reader for a standard is
legitimate; transcoding a standard into a house blob is not.** `.xgcov` is the
transcode — it converts HDF5 (a standard we can already read) into a format only
we understand, for zero gain.

## Decision

**Read whichever standard the data is already in, in place, via HTTP range —
and deprecate `.xgcov`.** The domain names the standard:

- **HDF5 / NetCDF** for scientific gridded data (S-100, NOAA model output) — make
  the existing HDF5 reader **range-capable** (fetch only the chunks a viewport
  needs; its superblock → b-tree → chunk walk is already the seek logic, it just
  reads from a full `ArrayBuffer` today).
- **COG** (Cloud-Optimized GeoTIFF) for georeferenced imagery/raster — read via
  `geotiff.js` (a reader for a standard), when a source is actually COG.
- **PMTiles** for vector tiles (already the path).

Conversion earns a place only for a source that genuinely cannot be read as-is;
it runs **server-side** and targets a **standard**, so the browser still
range-reads a standard in place. A bespoke container appears nowhere in the chain.

## Consequences

- **The HDF5 reader is the right artifact — it became the primary S-100 ingest.**
  Moved `@xgis/pipeline/hdf5` → `@xgis/data/hdf5` (so `@xgis/map` reads it in the
  browser) and added `readCoverageFromHdf5` (HDF5 bytes → `CoverageHandle` via
  `coverageFromGrids`, no wire format). Making it range/lazy is the remaining follow-up.
- **`.xgcov` was removed** — the codec (`encode`/`decode` in
  `data/src/coverage/format.ts`), `s100ToXgcov` + the `s100-to-xgcov` CLI, the blob
  `type: coverage` decode path, and the encode-based demo generators. The `coverage`
  source + `map.setCoverageData` now take **HDF5 bytes** and read in place. **The
  format-agnostic pieces survive unchanged**: `coverageFromGrids`, `CoverageHandle`,
  and `valueAt` (`data/src/coverage/format.ts`); the grid→texture→colour-ramp renderer
  (`map/src/render/coverage-renderer.ts` + material + `coverage-ramp` shader); the
  particle packer; and both demos (now synthetic S-102/S-111 `.h5`).
- **CORS is a separate axis, solved by a proxy — not a format concern.** NOAA's
  S3 buckets vary: `noaa-gfs-bdp-pds` / `noaa-goes16` send `access-control-allow-
origin: *` (browser-direct); `noaa-s102-pds` / `noaa-s111-pds` / `noaa-nos-ofs-
pds` do not, so a browser read needs a CORS proxy in front (server-to-server
  fetch has no CORS). All are downloadable server-side with Range (`206`).
- **Scale/tiling falls out for free.** Reading a standard in place already streams
  on demand (HDF5 chunks; COG tiles/overviews); there is no monolithic-blob
  download-all problem and no need for a tiled `.xgcov`.
- **#1279 (the S-111 PR built on `.xgcov`) was reworked**, not merged as-is: kept
  the reader/renderer/packer/demos, dropped the `.xgcov` path, switched ingest to
  read-in-place (a bundled small standard `.h5` for the deterministic demo/gate;
  a CORS-proxied remote read for the live path, per the recipes doc).

## Alternatives rejected

- **Keep `.xgcov` (single blob).** A custom format with no ecosystem and no
  streaming — the `.xgvt` mistake again.
- **Convert HDF5 → COG, then read the COG.** A pointless transcode: HDF5 is
  already the standard for this data and is itself range-readable. (My own first
  instinct reached for COG here and was wrong — COG is the standard for imagery,
  not for S-100 scientific grids.)
- **A tiled `.xgcov` (PMTiles-style archive).** That is a _new_ custom format; the
  standards already tile (HDF5 chunking, COG overviews). Reinventing PMTiles/COG
  for coverage is the same trap one level down.

## References

- `site/src/content/blog/2026-07-21-the-custom-format-trap.md` — the postmortem
- CLAUDE.md §12 "Architecture / data formats" — the one-line rule
- `docs/architecture/design/s100-gap1-hdf5-coverage.md` — the #1158 `.xgcov` design (superseded)
- `data/src/hdf5/` — the HDF5 reader (moved from `pipeline/`; to become range-capable) + `s102.ts` semantic layer + `coverage.ts` (`readCoverageFromHdf5`)
- `data/src/coverage/format.ts` — `coverageFromGrids` + `CoverageHandle` (the codec was removed)
- `map/src/render/coverage-renderer.ts` — the format-agnostic grid→ramp renderer (survives)
- #1271 (NOAA epic), #1272 (S-111), #1279 (the PR to rework), #1158 (original coverage)
