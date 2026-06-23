// ═══ Shader DSL — shared WGSL const handles ═══
//
// Typed handles for the module-level WGSL consts. The VALUES (+ their CPU mirrors) live in the
// ConstDecl arrays PROJECTION_CONSTS (projections.ts) / ECEF_CONSTS (ecef.ts) — the single source of
// truth a module emits. These are typed REFERENCES to those names: importing `EARTH_R` is typo-safe and
// autocompletes, where `constRef('EARTH_R')` is a bare string (a typo'd name compiles, then fails at WGSL
// link time). A constRef is a stateless name reference, so one shared handle per const is correct
// everywhere it is used.

import { constRef, type Node } from '@xgis/shader-dsl'

export const PI: Node<'f32'> = constRef('PI')
export const EARTH_R: Node<'f32'> = constRef('EARTH_R')
export const MERCATOR_LAT_LIMIT: Node<'f32'> = constRef('MERCATOR_LAT_LIMIT')
export const WGS84_A: Node<'f32'> = constRef('WGS84_A')
export const WGS84_E2: Node<'f32'> = constRef('WGS84_E2')
// Survives only as the (DEG2RAD·EARTH_R) divisor in the abs-Mercator → degree reverse paths; forward
// deg↔rad math uses the radians()/degrees() built-ins.
export const DEG2RAD: Node<'f32'> = constRef('DEG2RAD')
