// ═══ Shader DSL — parameterized compute kernel (PoC-C: parameterized thesis) ═══
//
// Re-authors compiler/src/codegen/compute-gen.ts `emitMatchComputeKernel`
// (the if-else path) as IR. This proves the IR supports PER-SCENE
// PARAMETERIZED emission: the arm count is an emission-time parameter that
// flows into the generated branch ladder, exactly as the data-driven compute
// path needs. Retiring this unknown in Phase 0 means the Phase-2.5 compiler
// re-target builds on a proven shape instead of discovering it late.
//
// colorHexToRGBA is replicated from compute-gen.ts for now; Phase 2.5 unifies
// it when compute-gen re-targets onto this builder (one parser, no drift).

import {
  fn, module, vec4, f32, pack4x8unorm,
  f32T, u32T, vec4fT, vec4uT, vec3uT,
  type ModuleDecl,
  If, Var, Return, } from '../core/ir'
import { storageBuffer, resource, builtin } from '../core/sot'

export interface MatchArm { pattern: string; colorHex: string }
export interface MatchKernelSpec {
  fieldName: string
  arms: MatchArm[]
  defaultColorHex: string
}

export const COMPUTE_WORKGROUP_SIZE = 64

// Replicated from compiler/src/codegen/compute-gen.ts (Phase-0 copy).
function colorHexToRGBA(hex: string): [number, number, number, number] {
  const h = hex
  let r = 0, g = 0, b = 0, a = 1
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h)) return [0, 0, 0, 1]
  if (h.length === 4) {
    r = parseInt(h[1]! + h[1]!, 16) / 255; g = parseInt(h[2]! + h[2]!, 16) / 255; b = parseInt(h[3]! + h[3]!, 16) / 255
  } else if (h.length === 5) {
    r = parseInt(h[1]! + h[1]!, 16) / 255; g = parseInt(h[2]! + h[2]!, 16) / 255; b = parseInt(h[3]! + h[3]!, 16) / 255; a = parseInt(h[4]! + h[4]!, 16) / 255
  } else if (h.length === 7) {
    r = parseInt(h.slice(1, 3), 16) / 255; g = parseInt(h.slice(3, 5), 16) / 255; b = parseInt(h.slice(5, 7), 16) / 255
  } else if (h.length === 9) {
    r = parseInt(h.slice(1, 3), 16) / 255; g = parseInt(h.slice(3, 5), 16) / 255; b = parseInt(h.slice(5, 7), 16) / 255; a = parseInt(h.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

const colorVec = (hex: string) => {
  const [r, g, b, a] = colorHexToRGBA(hex)
  return vec4(f32(r), f32(g), f32(b), f32(a))
}

/** Build the per-feature match() compute kernel as IR, parameterized by the
 *  scene's arm count. Mirrors emitMatchComputeKernel's if-else path: patterns
 *  are sorted alphabetically (the runtime's string→ID convention), the
 *  comparison `v_field == i` picks arm i's colour, else the default. */
export function matchComputeKernel(spec: MatchKernelSpec): ModuleDecl {
  const sortedPatterns = [...spec.arms.map((a) => a.pattern)].sort()
  const armByPattern = new Map(spec.arms.map((a) => [a.pattern, a]))

  const featDataB = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outColorB = storageBuffer('out_color', u32T, { group: 0, binding: 1, access: 'read_write' })
  const uCountB = resource('u_count', vec4uT, { group: 0, binding: 2 })
  const featData = featDataB.node
  const outColor = outColorB.node
  const uCount = uCountB.node

  const entry = fn('eval_match', { gid: builtin('global_invocation_id', vec3uT) }, ({ gid }, _b) => {
    const fid = gid.x
    If(fid.ge(uCount.x), () => { Return() })
    const v = featData.at(fid, f32T)
    const color = Var(vec4fT)

    // Parameterized if-else ladder — one arm per sorted pattern.
    const chain = If(v.eq(0), () => {
      color.assign(colorVec(armByPattern.get(sortedPatterns[0]!)!.colorHex))
    })
    for (let i = 1; i < sortedPatterns.length; i++) {
      chain.elif(v.eq(f32(i)), () => {
        color.assign(colorVec(armByPattern.get(sortedPatterns[i]!)!.colorHex))
      })
    }
    chain.else(() => { color.assign(colorVec(spec.defaultColorHex)) })

    outColor.at(fid, u32T).assign(pack4x8unorm(color))
  }, { stage: 'compute', workgroupSize: COMPUTE_WORKGROUP_SIZE })

  return module({
    bindings: [
      featDataB.binding,
      outColorB.binding,
      uCountB.binding,
    ],
    funcs: [entry],
  })
}

/** The sorted category order (string→ID) the runtime packer must use — same
 *  convention as compute-gen so the per-feature buffer fills identically. */
export const sortedCategoryOrder = (spec: MatchKernelSpec): string[] =>
  [...spec.arms.map((a) => a.pattern)].sort()
