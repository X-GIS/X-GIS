<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-25 -->

# tiler/cluster

## Purpose

Source-level point clustering for `type: geojson` sources — Mapbox `cluster` / `clusterRadius` / `clusterMaxZoom` / `clusterMinPoints` / `clusterProperties` (#2050). An X-GIS-original implementation of the supercluster hierarchy: index the points at `maxZoom + 1`, then for `z = maxZoom … 0` cluster the previous level's output with a radius that halves each zoom, each level indexed by its own k-d tree. `getTile` emits the SAME `TransformedTile` `geojsonvt/` emits, so `encodeMVT` consumes it verbatim and nothing downstream of the tiler changes.

It is a SIBLING of `geojsonvt/`, not a member of it, and that is deliberate: `geojsonvt/` is contractually a 1:1 port of ONE upstream project, and mixing a second project's algorithm into it would make that provenance claim false. Design record: `docs/plans/2026-08-24-geojson-clustering.md` (§4.1 for that choice and the two rejected alternatives, §2 for the reference semantics measured from `mapbox/supercluster@main`).

## Key Files

| File               | Description                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | `PointCluster` / `pointCluster` — input collection, the per-zoom hierarchy build (`buildLevel`), and the tile query (`getTile`) including the two antimeridian arms.                                                              |
| `units.ts`         | The numeric conventions this boundary owns: `clusterRadius` px → extent units (×16 at extent 8192), the Int32 quantization of the unit square, `minPoints` lifting, and the decodable `cluster_id` packing + its capacity assert. |
| `kd-tree.ts`       | Implicit static 2-D k-d tree (`range` / `within`) over one level's quantized coordinates. Rebuilt per zoom.                                                                                                                       |
| `cluster-props.ts` | `clusterProperties` map/reduce evaluation through `eval/evaluator.ts` with `accumulated` injected as a reserved key, plus `point_count_abbreviated` and the synthetic tag bag.                                                    |
| `types.ts`         | `ClusterOptions` / `ResolvedClusterOptions` / `ClusterLevel` / `CLUSTER_TAG`.                                                                                                                                                     |

## For AI Agents

### Working In This Directory

- **`clusterRadius` arrives in 512-px TILE PIXELS.** `SourceDef.clusterRadius` carries the style value verbatim (`ir/source-cluster.ts`'s UNITS block is the record for why), so THIS module applies `radius × extent / 512`. Passing the raw 50 into the neighbourhood test clusters at 1/16 the intended radius — a plausible-looking map with far too many clusters, and the easiest way to get this feature subtly wrong.
- **An unclustered point is emitted from the retained Float64 projections, never from the Int32 store.** The store's half-step is ~1.9 cm at the equator; reading a single point back through it moves it by that much, invisibly. Cluster centroids legitimately come from the store.
- **`cluster_id` must stay decodable** to (origin record index, origin zoom). That is the only thing keeping `getClusterExpansionZoom` / `getChildren` addable later without a rebuild; a dense sequential id would close that door by accident.
- Dependency direction: this directory may import from `geojsonvt/` (types, `projectX`/`projectY`, `transformPoint`) and from `eval/`. `geojsonvt/` imports NOTHING from here, so its ports stay byte-stable.
- No worker/pool/backend wiring lives here — the index is a pure CPU data structure. That wiring is `data/src/workers/geojson-tiling-worker.ts`'s.

### Testing Requirements

- Colocated. Each spec pins ONE separable mechanism so that cutting that mechanism turns exactly it red: `cluster-units.test.ts` (radius scale, minPoints, quantization, id packing, abbreviation), `cluster-hierarchy.test.ts` (radius ladder, `clusterMaxZoom` split, weighted centroid, the `minPoints` admission rule including the else-branch neighbour marking, input acceptance), `cluster-tile.test.ts` (empty-tile `null`, drift-free emit, the two antimeridian arms separately), `cluster-props.test.ts` (map/reduce, and the three independently-wrong-able halves of the reduce), `kd-tree.test.ts` (brute-force oracle above the 64-point leaf threshold).
- `kd-tree.test.ts` exists because every other spec here uses four points or fewer and `sortKd` returns immediately below `NODE_SIZE` — without it the whole split path would ship unexercised, and its failure mode is silently losing a point.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
