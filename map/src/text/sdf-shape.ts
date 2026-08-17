// ═══ SDF Shape System — GPU Storage Buffer Approach ═══
// Parses SVG path commands → stores segments in GPU storage buffers
// Fragment shader computes SDF in real-time (no texture atlas)

import type { RhiBuffer, RhiDevice } from '@xgis/engine'

// ═══ Types ═══

type PathCmd =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' }

/** GPU-side shape descriptor (matches WGSL struct) */
export interface ShapeDescData {
  segStart: number
  segCount: number
  bboxMinX: number
  bboxMinY: number
  bboxMaxX: number
  bboxMaxY: number
}

/** GPU-side segment (matches WGSL struct, 48 bytes) */
export interface SegmentData {
  kind: number // 0=line, 1=quadratic, 2=cubic
  colorIdx: number
  flags: number
  _pad: number
  p0x: number
  p0y: number
  p1x: number
  p1y: number
  p2x: number
  p2y: number
  p3x: number
  p3y: number
}

// ═══ SVG Path Parser ═══

/** Parse SVG path d-string into PathCmd array (M, L, C, Q, Z absolute only) */
function parseSVGPath(d: string): PathCmd[] {
  const cmds: PathCmd[] = []
  // Tokenize: split by command letters and extract numbers
  const tokens: (string | number)[] = []
  const re = /([MLCQZ])|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(d)) !== null) {
    if (m[1]) tokens.push(m[1].toUpperCase())
    else if (m[2]) tokens.push(parseFloat(m[2]))
  }

  let i = 0
  let currentCmd = ''
  const num = (): number => {
    if (i >= tokens.length || typeof tokens[i] !== 'number') return 0
    return tokens[i++] as number
  }

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') {
      currentCmd = tokens[i] as string
      i++
    }

    switch (currentCmd) {
      case 'M':
        cmds.push({ type: 'M', x: num(), y: num() })
        currentCmd = 'L' // implicit lineto after moveto
        break
      case 'L':
        cmds.push({ type: 'L', x: num(), y: num() })
        break
      case 'Q':
        cmds.push({ type: 'Q', x1: num(), y1: num(), x: num(), y: num() })
        break
      case 'C':
        cmds.push({ type: 'C', x1: num(), y1: num(), x2: num(), y2: num(), x: num(), y: num() })
        break
      case 'Z':
        cmds.push({ type: 'Z' })
        break
      default:
        i++ // skip unknown
    }
  }

  return cmds
}

/** Convert PathCmds to line/bezier segments with computed AABB.
 *  Implicit max-extent normalization: all coords are scaled so max(|coord|) = 1
 *  before segments are emitted. This gives `size N` a consistent meaning
 *  ("longest dimension renders at N units") regardless of how the path's
 *  source coords were authored. CSS `object-fit: contain` semantics. */
function pathToSegments(cmds: PathCmd[]): {
  segments: SegmentData[]
  bbox: [number, number, number, number]
} {
  // Pass 1: scan AABB from raw command coords to derive the normalization scale.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  const updateBBox = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M':
      case 'L':
        updateBBox(cmd.x, cmd.y)
        break
      case 'Q':
        updateBBox(cmd.x1, cmd.y1)
        updateBBox(cmd.x, cmd.y)
        break
      case 'C':
        updateBBox(cmd.x1, cmd.y1)
        updateBBox(cmd.x2, cmd.y2)
        updateBBox(cmd.x, cmd.y)
        break
      // 'Z' contributes nothing to the AABB
    }
  }
  // Degenerate paths (single point at origin, etc.) leave maxExtent==0; skip
  // scaling to avoid divide-by-zero. Otherwise scale = 1/maxExtent.
  const maxExtent = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY))
  const scale = maxExtent > 1e-6 ? 1 / maxExtent : 1
  const sx = (v: number) => v * scale

  // Pass 2: emit segments with normalized coords.
  const segments: SegmentData[] = []
  let cx = 0,
    cy = 0 // current point
  let mx = 0,
    my = 0 // move-to point (for Z close)

  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M':
        cx = sx(cmd.x)
        cy = sx(cmd.y)
        mx = cx
        my = cy
        break

      case 'L':
        segments.push({
          kind: 0,
          colorIdx: 0,
          flags: 0,
          _pad: 0,
          p0x: cx,
          p0y: cy,
          p1x: sx(cmd.x),
          p1y: sx(cmd.y),
          p2x: 0,
          p2y: 0,
          p3x: 0,
          p3y: 0,
        })
        cx = sx(cmd.x)
        cy = sx(cmd.y)
        break

      case 'Q':
        segments.push({
          kind: 1,
          colorIdx: 0,
          flags: 0,
          _pad: 0,
          p0x: cx,
          p0y: cy,
          p1x: sx(cmd.x1),
          p1y: sx(cmd.y1),
          p2x: sx(cmd.x),
          p2y: sx(cmd.y),
          p3x: 0,
          p3y: 0,
        })
        cx = sx(cmd.x)
        cy = sx(cmd.y)
        break

      case 'C':
        segments.push({
          kind: 2,
          colorIdx: 0,
          flags: 0,
          _pad: 0,
          p0x: cx,
          p0y: cy,
          p1x: sx(cmd.x1),
          p1y: sx(cmd.y1),
          p2x: sx(cmd.x2),
          p2y: sx(cmd.y2),
          p3x: sx(cmd.x),
          p3y: sx(cmd.y),
        })
        cx = sx(cmd.x)
        cy = sx(cmd.y)
        break

      case 'Z':
        if (cx !== mx || cy !== my) {
          segments.push({
            kind: 0,
            colorIdx: 0,
            flags: 0,
            _pad: 0,
            p0x: cx,
            p0y: cy,
            p1x: mx,
            p1y: my,
            p2x: 0,
            p2y: 0,
            p3x: 0,
            p3y: 0,
          })
          cx = mx
          cy = my
        }
        break
    }
  }

  // Bbox is in normalized path-local units; margin is also path-local
  // (0.1 of the unit square).
  const margin = 0.1
  return {
    segments,
    bbox: [
      minX * scale - margin,
      minY * scale - margin,
      maxX * scale + margin,
      maxY * scale + margin,
    ],
  }
}

/** Fraction of the bbox to shift by, per axis, for each anchor. `center` — and an unknown or absent
 *  value — is `(0, 0)`, i.e. the geometry is left exactly where the author drew it, which is what
 *  every shape predating #1550 relies on. */
const ANCHOR_SHIFT: Record<string, readonly [number, number]> = {
  center: [0, 0],
  // SIGNS ARE IN PATH SPACE, WHERE +Y IS DOWN — the SVG convention the parser reads and the one the
  // FS restores with `uv = (uv_in.x, −uv_in.y)` (`shaders/dsl/point.ts:257`). So the visual TOP edge
  // is the geometry's MINIMUM y, and anchoring to it means shifting the shape into positive y, i.e.
  // +0.5. Getting this backwards is invisible to a symmetric test glyph and to any mirror-symmetry
  // assertion; it took an absolute one to catch.
  top: [0, 0.5],
  bottom: [0, -0.5],
  left: [0.5, 0],
  right: [-0.5, 0],
}

/** Translate parsed geometry so the named anchor of its bounding box sits at the origin.
 *
 *  The shift is expressed as a FRACTION OF THE BOX rather than in absolute units, so it is
 *  correct for a symbol of any size and needs no normalisation pass. `top` means "the top edge is
 *  at the origin", i.e. the glyph hangs BELOW the point it marks — the convention a pin or a label
 *  callout wants, and the reason `anchor` exists in the grammar at all. */
function anchorGeometry(
  parsed: { segments: SegmentData[]; bbox: [number, number, number, number] },
  anchor?: string,
): { segments: SegmentData[]; bbox: [number, number, number, number] } {
  const shift = anchor ? ANCHOR_SHIFT[anchor] : undefined
  if (!shift || (shift[0] === 0 && shift[1] === 0)) return parsed
  const { bbox } = parsed
  const dx = -(bbox[0] + bbox[2]) / 2 + shift[0] * (bbox[2] - bbox[0])
  const dy = -(bbox[1] + bbox[3]) / 2 + shift[1] * (bbox[3] - bbox[1])
  const segments = parsed.segments.map((s) => ({
    ...s,
    p0x: s.p0x + dx,
    p0y: s.p0y + dy,
    p1x: s.p1x + dx,
    p1y: s.p1y + dy,
    p2x: s.p2x + dx,
    p2y: s.p2y + dy,
    p3x: s.p3x + dx,
    p3y: s.p3y + dy,
  }))
  return {
    segments,
    bbox: [bbox[0] + dx, bbox[1] + dy, bbox[2] + dx, bbox[3] + dy],
  }
}

// ═══ Built-in Shapes ═══

function regularPolygon(n: number, radius: number): string {
  const pts: string[] = []
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(4)} ${y.toFixed(4)}`)
  }
  return pts.join(' ') + ' Z'
}

function starPath(points: number, outerR: number, innerR: number): string {
  const pts: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / points
    const r = i % 2 === 0 ? outerR : innerR
    const x = Math.cos(angle) * r
    const y = Math.sin(angle) * r
    pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(4)} ${y.toFixed(4)}`)
  }
  return pts.join(' ') + ' Z'
}

/** Internal namespace prefix for user-defined (`symbol X { ... }`) shapes.
 *  Keeps them from colliding with built-in names like `cross`, `star`, etc.;
 *  lookup order in `getShapeId` is user → built-in so user definitions win
 *  when they share a name with a built-in. The prefix is never exposed to
 *  DSL authors — they reference shapes by their bare name. */
const USER_SHAPE_PREFIX = 'user:'

/** Built-in symbols, all authored at max(|coord|) = 1.0 so the source
 *  matches what `pathToSegments` produces post-normalization. Editing a
 *  built-in below ±1 here would still render correctly (the registry
 *  normalizes), but the source would no longer self-document the
 *  on-screen extent — keep them at ±1 for code clarity. */
export const BUILTIN_SHAPES: Record<string, string> = {
  square: 'M -1 -1 L 1 -1 L 1 1 L -1 1 Z',
  diamond: 'M 0 -1 L 0.7 0 L 0 1 L -0.7 0 Z',
  triangle: 'M 0 -1 L 0.9444 0.7222 L -0.9444 0.7222 Z',
  star: starPath(5, 1.0, 0.38),
  cross:
    'M -0.3333 -1 L 0.3333 -1 L 0.3333 -0.3333 L 1 -0.3333 L 1 0.3333 L 0.3333 0.3333 L 0.3333 1 L -0.3333 1 L -0.3333 0.3333 L -1 0.3333 L -1 -0.3333 L -0.3333 -0.3333 Z',
  hexagon: regularPolygon(6, 1.0),
  pentagon: regularPolygon(5, 1.0),
}

// ═══ Shape Registry ═══

/** Byte size of ShapeDesc on GPU (padded to 32 bytes) */
const SHAPE_DESC_FLOATS = 8 // seg_start(u32) + seg_count(u32) + bbox(4f) + pad(2)
/** Byte size of Segment on GPU (48 bytes = 12 floats) */
const SEGMENT_FLOATS = 12

export class ShapeRegistry {
  // The RHI seam (§4 batch-seam migration, step 3c). The shape/segment storage
  // buffers — shared by the point + line renderers — create/write/destroy through
  // this. On WebGPU `createBuffer === device.createBuffer` (bufUsage('storage',
  // writable:true) === STORAGE|COPY_DST), `writeBuffer === queue.writeBuffer`,
  // `destroyBuffer === GPUBuffer.destroy()`, so the GPU command stream stays
  // byte-identical; the renderers now consume `shapeBuffer`/`segmentBuffer` as
  // RhiBuffer directly (their transient wrapWebGpuBuffer wraps dropped here).
  private rhi: RhiDevice
  private shapes = new Map<string, { id: number; desc: ShapeDescData; segments: SegmentData[] }>()
  private allSegments: SegmentData[] = []
  private nextId = 1 // 0 = circle (analytical)
  private dirty = true

  private _shapeBuffer: RhiBuffer | null = null
  private _segmentBuffer: RhiBuffer | null = null

  constructor(rhi: RhiDevice) {
    this.rhi = rhi
    // Register built-in shapes
    for (const [name, path] of Object.entries(BUILTIN_SHAPES)) {
      this.addShape(name, path)
    }
  }

  /** Register a user-defined shape under the `user:` namespace so it cannot
   *  silently collide with built-ins. Callers still look it up by the bare
   *  name via `getShapeId`, which checks the prefixed key first. */
  addUserShape(name: string, svgPath: string, anchor?: string): number {
    return this.addShape(USER_SHAPE_PREFIX + name, svgPath, anchor)
  }

  /** Register a whole `symbol` block — every element of it — as ONE shape (#1766).
   *
   *  A block's elements arrive as one SVG path string each (`SymbolDef.paths`: one per `path` /
   *  `rect` / `circle`, lowered by compiler/src/ir/symbol-elements.ts). Registering them one at a
   *  time is what broke: `addShape` is keyed by NAME and returns early on a hit, so elements 2..N
   *  of `symbol arrow { path … rect … circle … }` were silently dropped.
   *
   *  Concatenation is the whole fix, and it is exact rather than an approximation: an SVG `d`
   *  string is a SEQUENCE of subpaths, so `M…Z M…Z` already IS the multi-element glyph — the
   *  parser reads the second `M` as a new subpath and the SDF's nonzero-winding test fills each
   *  one independently. Joining BEFORE parsing is also what makes the rest right: max-extent
   *  normalization and `anchorGeometry` then see the COMBINED bbox, which is the correct #1550
   *  semantics — the anchor moves the symbol's origin inside its OWN whole bbox, not inside its
   *  first element's.
   *
   *  Segment budget: the shader walks at most 32 segments per shape (`sdfShape` in
   *  shaders/dsl/point.ts), and a combined block spends that budget across all its elements. */
  addUserSymbol(name: string, paths: readonly string[], anchor?: string): number {
    return this.addUserShape(name, paths.join(' '), anchor)
  }

  /** Register a shape from SVG path string. Returns shape_id (1-based, 0=circle). */
  addShape(name: string, svgPath: string, anchor?: string): number {
    if (this.shapes.has(name)) return this.shapes.get(name)!.id

    const cmds = parseSVGPath(svgPath)
    const parsed = pathToSegments(cmds)
    // #1550 — `anchor` moves the symbol's ORIGIN inside its own bounding box, and it is applied
    // HERE because this is the only place that parses a path and therefore the only place that
    // knows the box. Applied as a translation of the geometry rather than as a field the shader
    // reads: the SDF evaluates path coordinates directly against the incoming uv (`point.ts:257`),
    // so moving the points IS moving the anchor, and no shader, no GPU struct and no draw path
    // changes. Absent anchor leaves the geometry untouched, so every existing shape is byte-identical.
    const { segments, bbox } = anchorGeometry(parsed, anchor)

    const id = this.nextId++
    const desc: ShapeDescData = {
      segStart: this.allSegments.length,
      segCount: segments.length,
      bboxMinX: bbox[0],
      bboxMinY: bbox[1],
      bboxMaxX: bbox[2],
      bboxMaxY: bbox[3],
    }

    this.allSegments.push(...segments)
    this.shapes.set(name, { id, desc, segments })
    this.dirty = true

    return id
  }

  /** Get shape_id by bare name. Returns 0 for "circle" or unknown.
   *  User-defined shapes (registered via `addUserShape`) take precedence over
   *  identically-named built-ins, so `symbol cross { ... }` in the DSL wins
   *  over the built-in `cross` glyph when referenced as `stroke-pattern-cross`. */
  getShapeId(name: string): number {
    if (name === 'circle') return 0
    const userHit = this.shapes.get(USER_SHAPE_PREFIX + name)
    if (userHit) return userHit.id
    return this.shapes.get(name)?.id ?? 0
  }

  /** Upload shape data to GPU if dirty. */
  uploadToGPU(): void {
    if (!this.dirty) return
    this.dirty = false

    // Build ShapeDesc buffer
    const shapeCount = this.nextId - 1
    const shapeData = new Float32Array(Math.max(shapeCount * SHAPE_DESC_FLOATS, 8))
    const shapeU32 = new Uint32Array(shapeData.buffer)

    for (const { id, desc } of this.shapes.values()) {
      const off = (id - 1) * SHAPE_DESC_FLOATS
      shapeU32[off + 0] = desc.segStart
      shapeU32[off + 1] = desc.segCount
      shapeData[off + 2] = desc.bboxMinX
      shapeData[off + 3] = desc.bboxMinY
      shapeData[off + 4] = desc.bboxMaxX
      shapeData[off + 5] = desc.bboxMaxY
      shapeData[off + 6] = 0 // pad
      shapeData[off + 7] = 0 // pad
    }

    // Build Segment buffer
    const segData = new Float32Array(Math.max(this.allSegments.length * SEGMENT_FLOATS, 12))
    const segU32 = new Uint32Array(segData.buffer)

    for (let i = 0; i < this.allSegments.length; i++) {
      const s = this.allSegments[i]
      const off = i * SEGMENT_FLOATS
      segU32[off + 0] = s.kind
      segU32[off + 1] = s.colorIdx
      segU32[off + 2] = s.flags
      segU32[off + 3] = s._pad
      segData[off + 4] = s.p0x
      segData[off + 5] = s.p0y
      segData[off + 6] = s.p1x
      segData[off + 7] = s.p1y
      segData[off + 8] = s.p2x
      segData[off + 9] = s.p2y
      segData[off + 10] = s.p3x
      segData[off + 11] = s.p3y
    }

    // Recreate GPU buffers. STORAGE|COPY_DST, byte-identical via
    // bufUsage('storage', writable:true); write = queue.writeBuffer,
    // destroy = GPUBuffer.destroy().
    if (this._shapeBuffer) this.rhi.destroyBuffer(this._shapeBuffer)
    if (this._segmentBuffer) this.rhi.destroyBuffer(this._segmentBuffer)

    this._shapeBuffer = this.rhi.createBuffer({
      size: Math.max(shapeData.byteLength, 32),
      usage: 'storage',
      writable: true,
      label: 'shape-descs',
    })
    this.rhi.writeBuffer(this._shapeBuffer, 0, shapeData)

    this._segmentBuffer = this.rhi.createBuffer({
      size: Math.max(segData.byteLength, 48),
      usage: 'storage',
      writable: true,
      label: 'shape-segments',
    })
    this.rhi.writeBuffer(this._segmentBuffer, 0, segData)
  }

  get shapeBuffer(): RhiBuffer {
    if (!this._shapeBuffer) this.uploadToGPU()
    return this._shapeBuffer!
  }

  get segmentBuffer(): RhiBuffer {
    if (!this._segmentBuffer) this.uploadToGPU()
    return this._segmentBuffer!
  }

  get shapeCount(): number {
    return this.nextId - 1
  }
}
