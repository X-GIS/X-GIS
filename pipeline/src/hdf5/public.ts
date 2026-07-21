// ═══ @xgis/pipeline/hdf5 — public S-100 HDF5 ingest surface ═══
//
// The subpath barrel for S-100 (HDF5) coverage ingest (#1158 / #1272), kept OFF
// the `@xgis/pipeline` main barrel because `s100ToXgcov` pulls in @xgis/data's
// .xgcov codec — so the ETL core (`@xgis/pipeline`: CSV / join / encode / odb)
// stays shared-only and lean. Two layers:
//
//   • the ZERO-DEP reader (`openHdf5` / `readS102Coverage` → `S100Coverage`) — for
//     consumers who bring their own encoder or only want the raw grid;
//   • the `s100ToXgcov` composition (reader → north-up flip → encodeCoverage) — the
//     one-call converter for a server (cron / edge) or a browser worker, the ONLY
//     thing here that depends on @xgis/data.
//
// Product-agnostic: S-102 bathymetry, S-104 water level, S-111 surface currents.

export { openHdf5, Hdf5File, Hdf5Error } from './index'
export type { Hdf5Node, AttrValue, Datatype, BandValues } from './index'
export { readS102Coverage } from './s102'
export type { S100Coverage, CoverageBand, Product } from './s102'
export { s100ToXgcov } from './to-xgcov'
export type { S100ToXgcovOptions, S100ToXgcovResult } from './to-xgcov'
