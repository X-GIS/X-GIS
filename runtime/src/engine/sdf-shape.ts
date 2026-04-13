// ═══ SDF Shape System — GPU Storage Buffer Approach ═══
// Parses SVG path commands → stores segments in GPU storage buffers
// Fragment shader computes SDF in real-time (no texture atlas)

// ═══ Types ═══

export type PathCmd =
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
  kind: number    // 0=line, 1=quadratic, 2=cubic
  colorIdx: number
  flags: number
  _pad: number
  p0x: number; p0y: number
  p1x: number; p1y: number
  p2x: number; p2y: number
  p3x: number; p3y: number
}

// ═══ SVG Path Parser ═══

/** Parse SVG path d-string into PathCmd array (M, L, C, Q, Z absolute only) */
export function parseSVGPath(d: string): PathCmd[] {
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

/** Convert PathCmds to line/bezier segments with computed AABB */
export function pathToSegments(cmds: PathCmd[]): { segments: SegmentData[]; bbox: [number, number, number, number] } {
  const segments: SegmentData[] = []
  let cx = 0, cy = 0 // current point
  let mx = 0, my = 0 // move-to point (for Z close)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  const updateBBox = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }

  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M':
        cx = cmd.x; cy = cmd.y
        mx = cx; my = cy
        updateBBox(cx, cy)
        break

      case 'L':
        updateBBox(cmd.x, cmd.y)
        segments.push({
          kind: 0, colorIdx: 0, flags: 0, _pad: 0,
          p0x: cx, p0y: cy,
          p1x: cmd.x, p1y: cmd.y,
          p2x: 0, p2y: 0, p3x: 0, p3y: 0,
        })
        cx = cmd.x; cy = cmd.y
        break

      case 'Q':
        updateBBox(cmd.x1, cmd.y1)
        updateBBox(cmd.x, cmd.y)
        segments.push({
          kind: 1, colorIdx: 0, flags: 0, _pad: 0,
          p0x: cx, p0y: cy,
          p1x: cmd.x1, p1y: cmd.y1,
          p2x: cmd.x, p2y: cmd.y,
          p3x: 0, p3y: 0,
        })
        cx = cmd.x; cy = cmd.y
        break

      case 'C':
        updateBBox(cmd.x1, cmd.y1)
        updateBBox(cmd.x2, cmd.y2)
        updateBBox(cmd.x, cmd.y)
        segments.push({
          kind: 2, colorIdx: 0, flags: 0, _pad: 0,
          p0x: cx, p0y: cy,
          p1x: cmd.x1, p1y: cmd.y1,
          p2x: cmd.x2, p2y: cmd.y2,
          p3x: cmd.x, p3y: cmd.y,
        })
        cx = cmd.x; cy = cmd.y
        break

      case 'Z':
        if (cx !== mx || cy !== my) {
          segments.push({
            kind: 0, colorIdx: 0, flags: 0, _pad: 0,
            p0x: cx, p0y: cy,
            p1x: mx, p1y: my,
            p2x: 0, p2y: 0, p3x: 0, p3y: 0,
          })
          cx = mx; cy = my
        }
        break
    }
  }

  // Add margin to AABB
  const margin = 0.1
  return {
    segments,
    bbox: [minX - margin, minY - margin, maxX + margin, maxY + margin],
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

export const BUILTIN_SHAPES: Record<string, string> = {
  square: 'M -0.75 -0.75 L 0.75 -0.75 L 0.75 0.75 L -0.75 0.75 Z',
  diamond: 'M 0 -1 L 0.7 0 L 0 1 L -0.7 0 Z',
  triangle: 'M 0 -0.9 L 0.85 0.65 L -0.85 0.65 Z',
  star: starPath(5, 1.0, 0.38),
  cross: 'M -0.3 -0.9 L 0.3 -0.9 L 0.3 -0.3 L 0.9 -0.3 L 0.9 0.3 L 0.3 0.3 L 0.3 0.9 L -0.3 0.9 L -0.3 0.3 L -0.9 0.3 L -0.9 -0.3 L -0.3 -0.3 Z',
  hexagon: regularPolygon(6, 0.9),
  pentagon: regularPolygon(5, 0.9),
}

// ═══ Shape Registry ═══

/** Byte size of ShapeDesc on GPU (padded to 32 bytes) */
const SHAPE_DESC_FLOATS = 8 // seg_start(u32) + seg_count(u32) + bbox(4f) + pad(2)
/** Byte size of Segment on GPU (48 bytes = 12 floats) */
const SEGMENT_FLOATS = 12

export class ShapeRegistry {
  private device: GPUDevice
  private shapes = new Map<string, { id: number; desc: ShapeDescData; segments: SegmentData[] }>()
  private allSegments: SegmentData[] = []
  private nextId = 1 // 0 = circle (analytical)
  private dirty = true

  private _shapeBuffer: GPUBuffer | null = null
  private _segmentBuffer: GPUBuffer | null = null

  constructor(device: GPUDevice) {
    this.device = device
    // Register built-in shapes
    for (const [name, path] of Object.entries(BUILTIN_SHAPES)) {
      this.addShape(name, path)
    }
  }

  /** Register a shape from SVG path string. Returns shape_id (1-based, 0=circle). */
  addShape(name: string, svgPath: string): number {
    if (this.shapes.has(name)) return this.shapes.get(name)!.id

    const cmds = parseSVGPath(svgPath)
    const { segments, bbox } = pathToSegments(cmds)

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

  /** Get shape_id by name. Returns 0 for "circle" or unknown. */
  getShapeId(name: string): number {
    if (name === 'circle') return 0
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
      segData[off + 4] = s.p0x; segData[off + 5] = s.p0y
      segData[off + 6] = s.p1x; segData[off + 7] = s.p1y
      segData[off + 8] = s.p2x; segData[off + 9] = s.p2y
      segData[off + 10] = s.p3x; segData[off + 11] = s.p3y
    }

    // Recreate GPU buffers
    this._shapeBuffer?.destroy()
    this._segmentBuffer?.destroy()

    this._shapeBuffer = this.device.createBuffer({
      size: Math.max(shapeData.byteLength, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'shape-descs',
    })
    this.device.queue.writeBuffer(this._shapeBuffer, 0, shapeData)

    this._segmentBuffer = this.device.createBuffer({
      size: Math.max(segData.byteLength, 48),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'shape-segments',
    })
    this.device.queue.writeBuffer(this._segmentBuffer, 0, segData)
  }

  get shapeBuffer(): GPUBuffer {
    if (!this._shapeBuffer) this.uploadToGPU()
    return this._shapeBuffer!
  }

  get segmentBuffer(): GPUBuffer {
    if (!this._segmentBuffer) this.uploadToGPU()
    return this._segmentBuffer!
  }

  get shapeCount(): number { return this.nextId - 1 }
}
