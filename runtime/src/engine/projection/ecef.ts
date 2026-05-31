// ═══ ECEF coordinate math — implementation moved to @xgis/shared ═══
//
// The ECEF / WGS84 helpers now live in @xgis/shared/ecef so the
// @xgis/compiler tiler can import the SAME source the runtime engine uses.
// The compiler↔runtime package barrier previously forced the tiler to
// hand-mirror these constants + the ellipsoid forward (the "mirrors
// runtime/src/engine/projection/ecef.ts" comments in vector-tiler.ts);
// they are real imports now, with the precision-fuzz tests pinning parity.
//
// This thin re-export keeps every existing `./ecef` / `../projection/ecef`
// import path inside the runtime stable — no engine consumer changed.
export * from '@xgis/shared'
