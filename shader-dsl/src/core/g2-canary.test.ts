import { describe, it, expect } from 'vitest'
import { uniformStruct, ioStruct, structDecl, storageBuffer, builtin, location } from './sot'
import { fn, Var, Let, Switch, matchEnum, enumU32, when, f32, vec2 } from './ir'
import { f32T, u32T, vec2fT, vec4fT } from './ir'

// ═══ #763 Phase G — the readonly invariant, pinned ═══
//
// G2: uniform fields / read-storage elements / read-base `.of()` views are
// ReadonlyNode (assign = tsc error). G3: fn params are ReadonlyNode. G4: the
// dispatch/loop tier (Switch, matchEnum, when, Loop init) ACCEPTS ReadonlyNode.
// The @ts-expect-error probes fail the build if the invariant regresses.

const U = uniformStruct('GUni', { group: 0, binding: 0, as: 'gu' }, { opacity: f32T, mode: u32T })
const Slot = structDecl('GSlot', { id: u32T, size: f32T })
const VsOut = ioStruct('GVsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

describe('#763 G — readonly invariant', () => {
  it('G2: uniform fields are read-only; read storage is read-only; read_write is mutable', () => {
    const readBuf = storageBuffer('g_r', Slot, { group: 0, binding: 1, access: 'read' })
    const rwBuf = storageBuffer('g_rw', f32T, { group: 0, binding: 2, access: 'read_write' })
    fn('g2', {}, () => {
      // @ts-expect-error — uniform space is read-only (#763 G2)
      U.field.opacity.assign(f32(0))
      // @ts-expect-error — access:'read' element fields are read-only (#763 G2)
      readBuf.at(0).size.assign(f32(1))
      rwBuf.at(0).assign(f32(1)) // read_write element IS assignable
      return f32(0)
    })
    expect(true).toBe(true)
  })

  it('G2: .of() write capability follows the base', () => {
    fn('g2b', {}, () => {
      const v = VsOut.var() // mutable base → Node fields
      v.uv.assign(vec2(0, 0))
      const ro = VsOut.of(Let(v.$)) // Let = read-only base → ReadonlyNode fields
      // @ts-expect-error — read-base view fields are read-only (#763 G2)
      ro.uv.assign(vec2(1, 1))
      return v.$
    })
    expect(true).toBe(true)
  })

  it('G3+G4: params are read-only AND the dispatch tier accepts them', () => {
    const Kind = enumU32({ A: 0, B: 1 })
    fn('g34', { lon: f32T, kind: u32T }, ({ lon, kind }) => {
      // @ts-expect-error — params are read-only in WGSL (#763 G3)
      lon.assign(f32(0))
      // G4: ReadonlyNode accepted at every read position that used to demand Node
      // (one arm returns a Let — ReadonlyNode — the other a plain Node)
      const picked = matchEnum<Record<'A' | 'B', number>, 'f32'>(kind, Kind, {
        A: () => Let(lon.mul(2)),
        B: () => lon,
      })
      const w = when<'f32'>(
        lon.gt(0),
        () => Let(lon.add(1)),
        () => lon,
      )
      const acc = Var(f32(0))
      Switch(kind) // a READ-ONLY param as scrutinee — the G3+G4 lock in one line
        .case(0, () => acc.assign(picked))
        .default(() => acc.assign(w))
      return acc
    })
    expect(true).toBe(true)
  })
})
