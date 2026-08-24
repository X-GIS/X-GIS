# The terrain family (ADR-0012 D5 + relatives) — design

Track scope, owner-directed (2026-08-24): the three surfaces that all read the
same decoded DEM — the top-level `terrain` block (Mapbox v3 + MapLibre root
form), the `["elevation"]` expression accessor (#2008), and the `color-relief`
layer type (#2009) — plus the converter `encoding` emit gap (#2003) that sits
underneath all three. Design by the D5 track session; implementation phased per
ADR-0012 §4.

## The one-sentence contract

Everything in this track is a CONSUMER of one already-landed primitive — the
RGBA8-decoded DEM texture and its unpack factors (`hillshade-renderer.ts:56-89`)
— so the track adds no new fetch, decode, or cache path, and every phase that
does add one is out of scope by construction.

## What is already built (verified against the code, not against a doc)

Per CLAUDE.md §12 "plan docs drift from landed reality", the predecessor scope
was re-derived from the tree at `f0e89d8`, not from ADR-0012's description of it:

| Link in the chain                                                                            | Where                                        | State                                                              |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `.xgis` grammar parses `encoding` / `redFactor` / `greenFactor` / `blueFactor` / `baseShift` | `compiler/src/ir/lower.ts:196-215`           | **landed**                                                         |
| Interpreter carries them on the source record                                                | `map/src/interpreter.ts:93-98`               | **landed**                                                         |
| Source-manager forwards them to the DEM load                                                 | `map/src/source-manager.ts:393-398`          | **landed** (#1983 / PR #2005)                                      |
| `demUnpack()` resolves mapbox / terrarium / custom factors                                   | `map/src/render/hillshade-renderer.ts:57-89` | **landed**                                                         |
| Source-level `tileSize` / `minzoom` / `maxzoom` emit + declared-path wiring                  | `sources.ts`, `source-manager.ts`            | **landed** (#1983 / PR #2005, `03927bf`)                           |
| **Converter EMITS `encoding` into the xgis source block**                                    | `compiler/src/convert/sources.ts:461-471`    | **MISSING — warns instead**                                        |
| Top-level `terrain`                                                                          | —                                            | absent; graph search for `terrain` returns 0 nodes                 |
| `["elevation"]`                                                                              | —                                            | absent; only `hsElevation` in the hillshade DSL exists             |
| `color-relief`                                                                               | —                                            | absent from `layers.ts:60`, `paint.ts:50`, `validate-layers.ts:67` |

The first row of that table is the finding that shapes the whole phasing: **the
`encoding` chain is complete at every link except the converter emit.** #2003 is
therefore the exact same shape as B1/#1983 — "grammar and runtime already exist,
only the emit is missing" — which is why it goes first and why it is a
converter-only diff.

### #2003 is a correctness defect, not only a missing feature

`sources.ts:468` warns on any non-`mapbox` encoding and emits nothing. The
runtime's `demUnpack()` then falls through to `MAPBOX_UNPACK`. So a
`encoding: "terrarium"` source today decodes terrarium bytes with the mapbox
formula:

- terrarium: `R*256 + G + B/256 − 32768`
- mapbox: `R*6553.6 + G*25.6 + B*0.1 − 10000`

For a mid-grey DEM texel (128,128,128) that is 128.5 m of real elevation read as
832 150 m. The hillshade over any Mapzen/Terrarium DEM is not subtly off; it is
saturated garbage. The warning is also stale — it promises the formula "when
hillshade lands", and hillshade landed in #777 Phase II.

## Socratic self-critique (before proposing anything)

**Q. Is `terrain` really one item, or two?**
Mapbox v3 and MapLibre spell the root block the same way (`{source,
exaggeration}`), so the CONVERTER half is genuinely one item. But "terrain"
colloquially means two unrelated things: the style-block parse, and 3D vertex
displacement of every draped layer. Conflating them is the trap — the block is
a day, the displacement is the rest of the track and then some. **They are split
in the phasing below, and the phase that lands the block explicitly does not
displace anything.**

**Q. Can `["elevation"]` reuse the `["zoom"]` pattern?**
Only for its converter half. `zoomHandler` (`expr-lookup.ts:136-153`) lowers to
a bare `zoom` identifier that the runtime resolves from `props[CAMERA_ZOOM_KEY]`
— a FRAME-global scalar, identical for every feature. Elevation is per-FEATURE
and per-POSITION: it needs a DEM sample at the feature's coordinate, which means
a tile lookup, a possibly-absent tile, and a resampling choice. The converter
half is a one-line registry append; the runtime half is the whole item. Any plan
that prices `["elevation"]` off the `["zoom"]` precedent is mispriced by an order
of magnitude.

**Q. What does `["elevation"]` return when the DEM tile is not loaded?**
This is the question that decides the design, and it has no good answer that is
also cheap. A style that colours by elevation would flash its
missing-data colour on every pan. The honest options are: block on the DEM (no —
couples feature eval to network), return 0 (silently wrong), or return a
documented sentinel and warn. **This is an open decision, deliberately left open
below rather than resolved by fiat here.**

**Q. Is `color-relief` a layer type or a paint mode of hillshade?**
MapLibre made it its own layer type, and it consumes the DEM through the same
decode. The temptation is to add it as a branch inside `HillshadeRenderer`,
reusing the tile cache. That file is **at its LOC ceiling of 850** — so the
temptation is also mechanically blocked, which is the ratchet doing exactly its
job. It gets its own renderer.

**Q. What is the smallest thing that ships value?**
#2003. It is converter-only, it fixes a live correctness defect for terrarium
DEM styles, it touches none of the coordination-frozen files, and it needs no
GPU tier. If this track shipped nothing else, that is still a real fix.

## Rejected alternatives (with the reason — the reason is the point)

**R1. Emit `terrain` as a new source property rather than a top-level block.**
Rejected: `terrain` REFERENCES a source by id (`{source: "dem", exaggeration:
1.5}`); it is not a property OF one. Folding it into the source block would make
two styles that share one DEM source unrepresentable, and would put a
render-time concern into the fetch-time record. It is a top-level block because
it is a top-level concern.

**R2. Implement `["elevation"]` by sampling the DEM on the GPU at draw time.**
Rejected: expressions are evaluated where the feature is processed (worker /
CPU), and their results feed buffer packing, not just shading. A GPU-side sample
cannot produce a value that a `["case"]` over `["elevation"]` needs before the
buffers are built. This also re-litigates the `distance-from-center` exclusion in
ADR-0012 §2 — the expression model has no per-frame hook, by decision.

**R3. Put `color-relief` inside `HillshadeRenderer` to share its DEM tile cache.**
Rejected on two independent grounds: the file is at its 850-line ceiling (the
ratchet is shrink-only — extract, never bump), and the file is
coordination-frozen until #1984's PR lands. Sharing the cache is still right; it
is done by extracting the DEM tile store, not by growing the renderer.

**R4. Add the terrain grammar to `compiler/src/ir/lower.ts`.**
Rejected: `lower.ts` is at **1514 lines against a ceiling of exactly 1514**. Any
line added there breaches the ratchet on the first commit. The terrain block's
lowering goes in a new sibling module, which is what the ratchet is steering
toward.

**R5. One PR for the whole track.**
Rejected per ADR-0012 §3 ("each ITEM ships alone") and §4.5 ("one item in flight
at a time"). The phases below are independently revertible.

## Phased plan

Each phase: issue filed BEFORE coding, fail-before witness reproduced red, fix,
full local gate (`bun run build` then `bun run test`, sequentially per CLAUDE.md
§7), draft PR, owner merge per §11.

### Phase 1 — `encoding` emit (#2003) · converter-only · no GPU tier

Emit `encoding` (and the `custom` unpack factors) from `sources.ts:461-471`
instead of warning; retire the stale "when hillshade lands" text.

- **Fail-before**: a converter test asserting a `encoding: "terrarium"` source
  produces an xgis source block containing `encoding: terrarium`. Red today
  (nothing is emitted). Witness corpus additionally covers `custom` with partial
  factors (only `redFactor` given → the other lanes must fall back per
  `demUnpack`'s documented behaviour) and the `mapbox` default (must stay
  byte-identical — see below).
- **Distinguishing check** (CLAUDE.md §12, "the assertion that failed either
  way"): assert the DECODED elevation differs between the two encodings, not
  merely that a line was emitted — an emit that reaches no consumer would pass a
  text-only assertion identically.
- **Byte-identity**: all 9 audited styles re-snapshotted; only styles that
  actually author a non-default `encoding` may move. Any other movement is a bug
  in this phase, not a baseline to re-bake.
- **Verification tier**: ADR-0004 Tier 1 only. No pixels change for
  mapbox-encoded styles, and the terrarium change is a value fix provable on the
  CPU via `demUnpack`.
- **Spec-coverage**: the `raster-dem` row's note loses "encoding is warn-only".
  Per §12 this is a THREE-way sync — row + regenerated `gap-matrix.md` +
  `RUNTIME_CAPABILITIES` — and the drift gate will breach if only one moves.

### Phase 2 — `terrain` block: parse, convert, warn precisely · converter-only

Accept both root forms, emit a terrain block into `.xgis`, and warn — precisely,
per ADR-0012 §1 — that displacement is not yet applied. This phase deliberately
renders nothing new.

- New lowering module (NOT `lower.ts`, per R4).
- **Fail-before**: a style with `{"terrain": {"source": "dem", "exaggeration":
1.5}}` currently drops it silently — the witness asserts both the emitted block
  and, for the interim, the warning naming property + reason + alternative.
- **Open decision for the issue**: whether `exaggeration` accepts the zoom-
  expression form on day one, or constant-only with a warn (the hillshade
  precedent at `paint-hillshade.ts:10` is constant-only, and matching it is the
  cheaper, more consistent default).
- **Verification tier**: Tier 1.

### Phase 3 — `color-relief` (#2009) · converter + NEW renderer · Tier 2

Hypsometric tint over the decoded DEM: a `color-relief-color` elevation→colour
ramp sampled per texel.

- Converter: new layer type through `layers.ts:60` / `paint.ts:50` /
  `validate-layers.ts:67`; the ramp lowers to the same LUT-texture shape the
  existing colour ramps use.
- Runtime: a NEW renderer module (R3). The DEM tile store is EXTRACTED from
  `HillshadeRenderer` so both consume one cache — extraction also buys back
  ceiling headroom on a file that has none.
- **Blocked on coordination**: this phase touches `hillshade-renderer.ts`. It
  must not start until #1984's PR has merged.
- **Verification tier**: ADR-0004 **Tier 2, mandatory** — pixels change. Per
  CLAUDE.md §5: directional pixel-diff (DC>0, D1<D0) against MapLibre's
  `color-relief`, and the diff image read in a 16-split at full resolution.
  A nonBg-percentage gate is explicitly NOT acceptable here — a hypsometric ramp
  is exactly the case where a pixel-count gate passes on a broken image.

### Phase 4 — `["elevation"]` (#2008) · expression runtime · Tier 1 + witness

- Converter: one registry append in `expr-registry.ts` (the module's own header
  documents this as the extension point).
- Runtime: the real work — a per-feature DEM sample at expression-eval time.
  Nearest-neighbour on the loaded DEM tile, with the missing-tile behaviour
  decided in the issue (see the open question above; it is NOT decided here).
- **Fail-before**: a witness that evaluates `["elevation"]` over a fixture DEM
  with known texel values and asserts metre-accurate output for BOTH encodings —
  which also makes it a regression test for Phase 1.
- **Instrument check** (§12, "every test passed offset-zero"): the fixture must
  include a feature whose coordinate is NOT at a tile origin and NOT at texel
  centre, since origin-aligned samples are the case where a correct bilinear
  fetch and a broken one agree.

### Phase 5 — terrain displacement — OUT OF SCOPE, named here so it is not assumed

Actual 3D vertex displacement of draped layers is a separate multi-week item
(it touches every layer renderer's vertex path, the depth model, and picking).
It is NOT part of this track. Phase 2 ships the block with a precise warning
precisely so this can be sequenced independently.

## LOC-ceiling risk table

Measured with `git show HEAD:<file> | wc -l` (§12 — post-prettier committed
state, never the working tree). Ratchet is **shrink-only**: extract, never bump.

| File                                   | Now  | Ceiling                             | Headroom | Phase | Risk / mitigation                                                                                                                                                                        |
| -------------------------------------- | ---- | ----------------------------------- | -------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compiler/src/ir/lower.ts`             | 1514 | **1514**                            | **0**    | 2     | **Breaches on line one.** Terrain lowering goes in a new sibling module (R4).                                                                                                            |
| `map/src/render/hillshade-renderer.ts` | 850  | **850**                             | **0**    | 3     | **Breaches on line one**, and coordination-frozen. DEM tile store is EXTRACTED out; extraction lowers the ceiling (a win the ratchet wants).                                             |
| `compiler/src/convert/sources.ts`      | 679  | 800 (`NEW_FILE_CAP`, non-baselined) | 121      | 1     | Phase 1's emit is ~15 lines. Comfortable, but the file is the converter's busiest — if the campaign session lands source work first, re-measure after the merge, do not assume this row. |
| `map/src/interpreter.ts`               | 295  | 800 (non-baselined)                 | 505      | 4     | Low risk.                                                                                                                                                                                |
| `map/src/source-manager.ts`            | —    | 1068                                | —        | —     | Not touched by this track (coordination freeze).                                                                                                                                         |

Two of the five rows are at **exactly zero headroom**. That is the single
largest mechanical risk in this track, it is known before any code is written,
and in both cases the mitigation is extraction — which is what the ratchet
exists to force.

## Coordination

The campaign session (x-gis) is actively merging converter/source work.
`git fetch && git merge origin/main` before EACH phase. Do not edit
`map/src/render/hillshade-renderer.ts` or `map/src/source-manager.ts` until
#1984's PR (source `bounds`) has merged. Phases 1, 2 and 4's converter half need
neither file; Phase 3 needs both and is gated on that merge.

## Open decisions (deliberately not resolved here — each belongs in its issue)

1. `["elevation"]` on a not-yet-loaded DEM tile: sentinel + warn, or 0?
2. `terrain.exaggeration`: zoom-expression form on day one, or constant-only
   with a warn matching the hillshade precedent?
3. Whether Phase 3's DEM tile-store extraction should also absorb the
   raster-dem fetch path, or stop at the decoded-texture cache.
