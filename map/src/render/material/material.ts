// ═══ Re-export shim — Material moved to @xgis/engine (#991 P1) ═══
//
// The generic descriptor-driven draw backbone (Material + executeItems + the
// MaterialDesc/PipelineVariant/DrawItem triad) is content-blind, so it now lives in
// @xgis/engine (engine/src/render/material.ts). Map's primitive builders import it
// from '@xgis/engine' directly; this shim only preserves @xgis/map's PUBLIC surface
// (re-exported via map/src/index.ts) for external consumers that import
// { Material, executeItems } from '@xgis/map' (the playground proofs). Retire at the
// EPIC close-out once those consumers import from '@xgis/engine'.

export { Material, executeItems } from '@xgis/engine'
export type { MaterialDesc, PipelineVariant, DrawItem } from '@xgis/engine'
