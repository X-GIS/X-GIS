// ═══ Shader DSL — stage IO attributes (the @location/@builtin read SoT) ═══
//
// An entry point's INTERFACE is its `@location(n)` / `@builtin(name)`-attributed
// fields — the quantity a host validates a vertex/fragment pair against, builds a
// GPUVertexState from, or links varyings by. Every one of those facts is already
// structured in the IR (`FuncDecl.params[].location`, `StructField.location`), with
// the emitted attribute STRING as a fallback for hand-built FuncDecl literals and
// bare `retAttr`s — the #740 R3 "structured first, attr second" contract that
// `stageOf` / `workgroupSizeOf` follow.
//
// This file is that read, once. It used to live inside the GLSL backend (its
// `parseAttrString`/`ioAttr` pair), which meant a CONSUMER of `reflect()` — where the
// interface is actually published — had no way to reach it and re-implemented the
// attribute walk with its own regex (#1905). Two readers of one spelling is the drift
// class this package exists to remove: they disagree and the varying-parity gate
// greenlights a pair GLSL then fails to link.
//
// Deliberately NOT in the `core/ir` barrel: it is an internal read helper, not
// authoring surface. `reflect()` publishes its result as `EntryInfo.io`.

import type { FuncDecl, StructDecl, StructField } from './nodes.js'
import type { ShaderType } from './types.js'

const LOCATION_RE = /@location\((\d+)\)/
const BUILTIN_RE = /@builtin\((\w+)\)/
const INTERPOLATE_RE = /@interpolate\((\w+)\)/

/** The IO attribute of one stage-interface field: exactly one of `location`/`builtin`
 *  (a WGSL field carries one or the other), plus `interpolate` which only ever rides
 *  along with a `location`. */
export interface IoAttr {
  location?: number
  builtin?: string
  interpolate?: string
}

/** String fallback ONLY (#740 R3): sot-authored fields carry structured
 *  location/builtin — read those via {@link ioAttrOf}. This regex path survives
 *  solely for hand-built FuncDecl literals and bare `retAttr` strings. */
export function parseIoAttrString(attr: string | undefined): IoAttr {
  if (!attr) return {}
  const loc = attr.match(LOCATION_RE)
  if (loc) {
    const interp = attr.match(INTERPOLATE_RE)
    return { location: Number(loc[1]), ...(interp ? { interpolate: interp[1] } : {}) }
  }
  const b = attr.match(BUILTIN_RE)
  if (b) return { builtin: b[1] }
  return {}
}

/** Structured-first IO attr read (#740 R3). `interpolate` rides along (#763 P4)
 *  so `@interpolate(flat)` float varyings emit GLSL `flat` — they used to
 *  interpolate smooth on WebGL2 while WGSL got provoking-vertex flat. */
export function ioAttrOf(
  src:
    | {
        readonly location?: number
        readonly builtin?: string
        readonly interpolate?: string
        readonly attr?: string
      }
    | undefined,
): IoAttr {
  if (!src) return {}
  if (src.location !== undefined)
    return {
      location: src.location,
      ...(src.interpolate !== undefined ? { interpolate: src.interpolate } : {}),
    }
  if (src.builtin !== undefined) return { builtin: src.builtin }
  return parseIoAttrString(src.attr)
}

/** The IO attribute of a BARE (non-struct) stage return — `-> @location(0) vec4<f32>`,
 *  `-> @builtin(point_size) f32`. Structured `retBuiltin` first (#1672 preserved it for
 *  exactly this read), `retAttr`'s spelling second, which is the only source for the
 *  LOCATION half: the IR has no `retLocation` twin. */
export function retIoAttrOf(f: Pick<FuncDecl, 'retAttr' | 'retBuiltin'>): IoAttr {
  return f.retBuiltin !== undefined ? { builtin: f.retBuiltin } : parseIoAttrString(f.retAttr)
}

/** One field of a stage interface, still carrying its `ShaderType` (a caller that wants
 *  a type KEY maps it — `reflect()` does). `name` is the field's own identifier: a
 *  param's name, a flattened struct field's name, or `_ret` for a bare non-struct
 *  return (the name the GLSL backend gives that same output). */
export interface IoField extends IoAttr {
  name: string
  type: ShaderType
}

const fieldOf = (f: StructField): IoField => ({ name: f.name, type: f.type, ...ioAttrOf(f) })

/** Flatten ONE side of an entry signature — a param, or a return — to the stage-interface
 *  fields it contributes. A struct is flattened to its fields (that IS the interface: WGSL
 *  lets an entry spell the same varyings either way, and a consumer comparing two stages
 *  must not care which form each side used); `void` contributes nothing; anything else is
 *  one field under `fallbackName` carrying `attr`'s own IO attribute.
 *
 *  A struct type whose decl is absent from `structs` degrades to the single-field form
 *  rather than throwing — this read is used by `reflect()`, which is pure and read-only
 *  over the IR and must describe a malformed module rather than reject it. */
export function ioFieldsOf(
  t: ShaderType,
  attr: IoAttr,
  fallbackName: string,
  structs: ReadonlyMap<string, StructDecl>,
): IoField[] {
  if (t.kind === 'void') return []
  if (t.kind === 'struct') {
    const s = structs.get(t.name)
    if (s) return s.fields.map(fieldOf)
  }
  return [{ name: fallbackName, type: t, ...attr }]
}

/** The full stage interface of an entry point: every `@location`/`@builtin` field its
 *  params contribute, and every one its return contributes, both flattened through
 *  {@link ioFieldsOf}. Builtins are KEPT — a consumer excluding them (varying parity does)
 *  needs to see that `position` exists to say why it was excluded. */
export function entryIo(
  f: Pick<FuncDecl, 'params' | 'ret' | 'retAttr' | 'retBuiltin'>,
  structs: ReadonlyMap<string, StructDecl>,
): { inputs: IoField[]; outputs: IoField[] } {
  return {
    inputs: f.params.flatMap((p) => ioFieldsOf(p.type, ioAttrOf(p), p.name, structs)),
    outputs: ioFieldsOf(f.ret, retIoAttrOf(f), '_ret', structs),
  }
}
