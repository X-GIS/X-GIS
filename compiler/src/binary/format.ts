// ═══ .xgb Binary Format — X-GIS Compiled Binary ═══
//
// Magic: "XGIS" (4 bytes)
// Version: u16
// Command count: u16
// Commands: [LoadCommand | ShowCommand]
//
// 파싱 없이 바로 실행 가능한 중간 표현

const MAGIC = 0x53494758 // "XGIS" in little-endian
const VERSION = 2

export interface BinaryScene {
  loads: BinaryLoad[]
  shows: BinaryShow[]
}

export interface BinaryLoad {
  name: string
  url: string
}

export interface BinaryShow {
  targetName: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  projection?: string
  visible?: boolean
  opacity?: number
  zOrder?: number
}

// ═══ Serialize → ArrayBuffer ═══

export function serializeXGB(scene: BinaryScene): ArrayBuffer {
  const encoder = new BinaryEncoder()

  // Header
  encoder.writeU32(MAGIC)
  encoder.writeU16(VERSION)

  // Loads
  encoder.writeU16(scene.loads.length)
  for (const load of scene.loads) {
    encoder.writeString(load.name)
    encoder.writeString(load.url)
  }

  // Shows
  encoder.writeU16(scene.shows.length)
  for (const show of scene.shows) {
    encoder.writeString(show.targetName)
    encoder.writeString(show.fill ?? '')
    encoder.writeString(show.stroke ?? '')
    encoder.writeF32(show.strokeWidth)
    // v2 fields
    encoder.writeString(show.projection ?? 'mercator')
    encoder.writeU8(show.visible === false ? 0 : 1)
    encoder.writeF32(show.opacity ?? 1.0)
    encoder.writeU16(show.zOrder ?? 0)
  }

  return encoder.finish()
}

// ═══ Deserialize ← ArrayBuffer ═══

export function deserializeXGB(buffer: ArrayBuffer): BinaryScene {
  const decoder = new BinaryDecoder(buffer)

  // Header
  const magic = decoder.readU32()
  if (magic !== MAGIC) {
    throw new Error(`Invalid .xgb file (expected XGIS magic, got 0x${magic.toString(16)})`)
  }

  const version = decoder.readU16()
  if (version !== 1 && version !== VERSION) {
    throw new Error(`Unsupported .xgb version: ${version} (expected ${VERSION})`)
  }

  // Loads
  const loadCount = decoder.readU16()
  const loads: BinaryLoad[] = []
  for (let i = 0; i < loadCount; i++) {
    loads.push({
      name: decoder.readString(),
      url: decoder.readString(),
    })
  }

  // Shows
  const showCount = decoder.readU16()
  const shows: BinaryShow[] = []
  for (let i = 0; i < showCount; i++) {
    const targetName = decoder.readString()
    const fill = decoder.readString() || null
    const stroke = decoder.readString() || null
    const strokeWidth = decoder.readF32()

    // v2 fields (absent in v1)
    let projection = 'mercator'
    let visible = true
    let opacity = 1.0
    let zOrder = 0
    if (version >= 2) {
      projection = decoder.readString()
      visible = decoder.readU8() !== 0
      opacity = decoder.readF32()
      zOrder = decoder.readU16()
    }

    shows.push({ targetName, fill, stroke, strokeWidth, projection, visible, opacity, zOrder })
  }

  return { loads, shows }
}

// ═══ Binary Encoder ═══

class BinaryEncoder {
  private buffer: number[] = []

  writeU8(value: number): void {
    this.buffer.push(value & 0xff)
  }

  writeU16(value: number): void {
    this.buffer.push(value & 0xff, (value >> 8) & 0xff)
  }

  writeU32(value: number): void {
    this.buffer.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    )
  }

  writeF32(value: number): void {
    const view = new DataView(new ArrayBuffer(4))
    view.setFloat32(0, value, true)
    for (let i = 0; i < 4; i++) this.buffer.push(view.getUint8(i))
  }

  writeString(str: string): void {
    const bytes = new TextEncoder().encode(str)
    this.writeU16(bytes.length)
    for (const b of bytes) this.buffer.push(b)
  }

  finish(): ArrayBuffer {
    return new Uint8Array(this.buffer).buffer
  }
}

// ═══ Binary Decoder ═══

class BinaryDecoder {
  private view: DataView
  private pos = 0

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
  }

  readU8(): number {
    return this.view.getUint8(this.pos++)
  }

  readU16(): number {
    const val = this.view.getUint16(this.pos, true)
    this.pos += 2
    return val
  }

  readU32(): number {
    const val = this.view.getUint32(this.pos, true)
    this.pos += 4
    return val
  }

  readF32(): number {
    const val = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return val
  }

  readString(): string {
    const len = this.readU16()
    const bytes = new Uint8Array(this.view.buffer, this.pos, len)
    this.pos += len
    return new TextDecoder().decode(bytes)
  }
}
