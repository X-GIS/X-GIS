// ═══ @xgis/pipeline — public barrel ═══
//
// A render-agnostic, GPU-free, country-generic toolkit that turns raw, code-keyed
// public data into X-GIS visualizations: ingest → join (standard code → geometry)
// → transform → encode, emitting into the existing map.setSourcePoints /
// setSourceData seams. Design + rationale: docs/architecture/data-to-viz-pipeline.md.
// Source is split by pipeline stage: core/ · ingest/ · transform/ · join/ ·
// gazetteer/ (country snapshots) · encode/.

export type { Table, Cell } from './core/table'
export { ColumnarTable } from './core/table'

export { fromCSV, fromRows } from './ingest'

export type { Agg } from './transform'
export { where, filter, groupBy, selectRows } from './transform'

export type { AdminLevel, GazetteerMeta, Gazetteer, GazEntry } from './join'
export { makeGazetteer, join } from './join'

export type { PointPatch, FeatureCollectionLike, PipelineSink, EncodeResult } from './encode'
export { bubble, points } from './encode'

// Declarative orchestrator — the essence surface (which / how-loaded / how-shown) over the verbs.
export type { JoinSpec, LoadSpec } from './load'
export { load } from './load'

// Country gazetteer snapshots — also at the '@xgis/pipeline/gazetteer/<cc>' subpath.
export { seoulSigunguGazetteer, SEOUL_SIGUNGU } from './gazetteer/kr'

// Pipeline-backed source loaders for the map's `XGISMapOptions.sources` seam.
export type { LoaderContext, LoaderResult, SourceLoader } from './loaders'
export { krAdminLoader, odbLoader } from './loaders'

// .odb OD-flow binary — compact aggregated origin→destination payload.
export type { ODFlow, ODBData } from './odb/format'
export {
  encodeODB,
  decodeODB,
  ODB_MAGIC,
  ODB_VERSION,
  ODB_HOUR_ALLDAY,
} from './odb/format'
