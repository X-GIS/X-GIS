// ═══ HDF5 subset reader — object nodes + group traversal ═══
//
// An object node = the messages of one object header, lazily interpreted into
// attributes, group children, and (for datasets) the dataspace/datatype/layout/
// fill/filter descriptors. Group children come from EITHER a symbol-table message
// (v0 / earliest format) OR compact Link messages (1.8 latest) — both in subset;
// dense link / attribute storage (fractal heap) is a hard error (A1).

import { Cursor, Hdf5Error } from './bytes'
import { parseObjectHeader, MSG, type RawMessage } from './object-header'
import { walkGroupBtree } from './btree-v1'
import {
  parseAttribute,
  parseAttributeInfoDenseGuard,
  parseDataspace,
  parseFillValue,
  parseFilterPipeline,
  parseLayout,
  parseLink,
  parseLinkInfoDenseGuard,
  parseSymbolTable,
  type AttrValue,
  type FilterSpec,
  type Layout,
} from './messages'
import { parseDatatype, type Datatype } from './datatype'

export type { AttrValue }

export interface DatasetInfo {
  dims: number[]
  datatype: Datatype
  layout: Layout
  fillValue: Uint8Array | null
  filters: FilterSpec[]
}

export class Hdf5Node {
  private _attrs?: Map<string, AttrValue>
  private _children?: Map<string, number>

  constructor(
    readonly c: Cursor,
    readonly addr: number,
    readonly messages: RawMessage[],
  ) {}

  /** Compact attribute messages, name → decoded value (case-preserving). Dense
   *  attribute storage is rejected here (A1). */
  attrs(): Map<string, AttrValue> {
    if (this._attrs) return this._attrs
    const out = new Map<string, AttrValue>()
    for (const m of this.messages) {
      if (m.type === MSG.ATTRIBUTE_INFO) parseAttributeInfoDenseGuard(this.c, m.bodyStart)
      else if (m.type === MSG.ATTRIBUTE) {
        const a = parseAttribute(this.c, m.bodyStart)
        out.set(a.name, a.value)
      }
    }
    this._attrs = out
    return out
  }

  /** Case-tolerant attribute lookup ([FR] §7.10) — exact match first, then a
   *  case-insensitive fallback that logs a warning to `warn` (stderr in the CLI). */
  attr(name: string, warn?: (msg: string) => void): AttrValue | undefined {
    const a = this.attrs()
    if (a.has(name)) return a.get(name)
    const lower = name.toLowerCase()
    for (const [k, v] of a)
      if (k.toLowerCase() === lower) {
        warn?.(`attribute casing: found "${k}", expected "${name}"`)
        return v
      }
    return undefined
  }

  /** Group children (name → object-header address), or an empty map for a
   *  dataset / childless group. Symbol-table AND compact-link groups supported. */
  children(): Map<string, number> {
    if (this._children) return this._children
    const out = new Map<string, number>()
    let symbolTable: { btreeAddress: number; localHeapAddress: number } | null = null
    for (const m of this.messages) {
      if (m.type === MSG.SYMBOL_TABLE) symbolTable = parseSymbolTable(this.c, m.bodyStart)
      else if (m.type === MSG.LINK_INFO) parseLinkInfoDenseGuard(this.c, m.bodyStart)
      else if (m.type === MSG.LINK) {
        const link = parseLink(this.c, m.bodyStart)
        if (link) out.set(link.name, link.targetAddress)
      }
    }
    if (symbolTable) {
      const save = this.c.pos
      for (const [name, addr] of walkGroupBtree(
        this.c,
        symbolTable.btreeAddress,
        symbolTable.localHeapAddress,
      ))
        out.set(name, addr)
      this.c.seek(save)
    }
    this._children = out
    return out
  }

  /** Interpret this node as a dataset (dataspace + datatype + layout present). */
  asDataset(): DatasetInfo {
    let dims: number[] | null = null
    let datatype: Datatype | null = null
    let layout: Layout | null = null
    let fillValue: Uint8Array | null = null
    let filters: FilterSpec[] = []
    for (const m of this.messages) {
      if (m.type === MSG.DATASPACE) dims = parseDataspace(this.c, m.bodyStart)
      else if (m.type === MSG.DATATYPE) datatype = parseDatatype(this.c, m.bodyStart)
      else if (m.type === MSG.LAYOUT) layout = parseLayout(this.c, m.bodyStart)
      else if (m.type === MSG.FILL_VALUE) fillValue = parseFillValue(this.c, m.bodyStart, false)
      else if (m.type === MSG.FILL_VALUE_OLD && fillValue === null)
        fillValue = parseFillValue(this.c, m.bodyStart, true)
      else if (m.type === MSG.FILTER_PIPELINE) filters = parseFilterPipeline(this.c, m.bodyStart)
    }
    if (!dims || !datatype || !layout)
      throw new Hdf5Error(
        `object at 0x${this.addr.toString(16)} is not a dataset ` +
          `(dataspace=${!!dims} datatype=${!!datatype} layout=${!!layout})`,
        this.addr,
      )
    return { dims, datatype, layout, fillValue, filters }
  }

  isDataset(): boolean {
    return this.messages.some((m) => m.type === MSG.LAYOUT)
  }
}

/** Parse the object node at `addr`. */
export function readNode(c: Cursor, addr: number): Hdf5Node {
  return new Hdf5Node(c, addr, parseObjectHeader(c, addr))
}

/** Resolve a "/"-separated path from `rootAddr` to a node, or throw naming the
 *  first missing segment. */
export function resolvePath(c: Cursor, rootAddr: number, path: string): Hdf5Node {
  let node = readNode(c, rootAddr)
  const parts = path.split('/').filter((p) => p.length > 0)
  for (let i = 0; i < parts.length; i++) {
    const childAddr = node.children().get(parts[i]!)
    if (childAddr === undefined)
      throw new Hdf5Error(
        `path segment "${parts[i]}" not found under "/${parts.slice(0, i).join('/')}"`,
        node.addr,
      )
    node = readNode(c, childAddr)
  }
  return node
}
