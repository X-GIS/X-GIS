// Back-compat re-export shim. The implementation moved to
// data/tile-catalog.ts as Step 6 of the layer-type refactor
// (plans/delegated-hopping-cray.md) — XGVTSource was always
// playing catalog/router, not "the .xgvt format source", so it
// got renamed to TileCatalog. This shim preserves the public
// import path so external callers (loadPMTilesSource, the test
// suite, third-party code holding the type) keep compiling.
//
// New code should import { TileCatalog } from './tile-catalog'.

export { TileCatalog as XGVTSource } from './tile-catalog'
export {
  type TileData,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  type VirtualCatalog, type VirtualTileFetcher,
} from './tile-types'
