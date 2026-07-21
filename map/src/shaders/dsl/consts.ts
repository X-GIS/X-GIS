// ═══ Shader DSL — shared WGSL const handles ═══
//
// Typed handles for the module-level WGSL consts. The VALUES (+ their CPU mirrors) live in the
// ConstDecl arrays PROJECTION_CONSTS (projections.ts) / ECEF_CONSTS (ecef.ts) — the single source of
// truth a module emits. These are typed REFERENCES to those names: importing `EARTH_R` is typo-safe and
// autocompletes, where `constRef('EARTH_R')` is a bare string (a typo'd name compiles, then fails at WGSL
// link time). A constRef is a stateless name reference, so one shared handle per const is correct
// everywhere it is used.

import { constRef, type ReadonlyNode } from '@xgis/shader-dsl'

// Module-level consts are immutable references → ReadonlyNode (no `.assign`); they flow into
// every read-API (which accepts the ReadonlyNode supertype) but cannot be a mutation target.
export const PI: ReadonlyNode<'f32'> = constRef('PI')
export const EARTH_R: ReadonlyNode<'f32'> = constRef('EARTH_R')
// #1152 INC-3 — proj_globe's ellipsoid first-eccentricity² (N = EARTH_R/√(1−E2·sin²φ)).
// A SEPARATE PROJECTION_CONSTS decl from ECEF's WGS84_E2 (two names, one body.e2
// value — the shipped EARTH_R/WGS84_A precedent): proj_globe lives in modules that
// merge only PROJECTION_CONSTS, where the ECEF handle is absent (WGSL link + CPU
// lowering would break); raster/line/under-occluder merge BOTH arrays, so a
// same-NAME decl would collide. body-consts.test.ts pins EARTH_E2 === WGS84_E2 (bit).
export const EARTH_E2: ReadonlyNode<'f32'> = constRef('EARTH_E2')
export const MERCATOR_LAT_LIMIT: ReadonlyNode<'f32'> = constRef('MERCATOR_LAT_LIMIT')
export const WGS84_A: ReadonlyNode<'f32'> = constRef('WGS84_A')
export const WGS84_E2: ReadonlyNode<'f32'> = constRef('WGS84_E2')
// Survives only as the (DEG2RAD·EARTH_R) divisor in the abs-Mercator → degree reverse paths; forward
// deg↔rad math uses the radians()/degrees() built-ins.
export const DEG2RAD: ReadonlyNode<'f32'> = constRef('DEG2RAD')
