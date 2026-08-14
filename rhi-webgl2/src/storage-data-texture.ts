// ═══ WebGL2 storage-buffer emulation — the 2D-tiled data texture ═══
//
// GLSL ES 3.00 has no SSBO, so an RHI `usage: 'storage'` buffer is emulated as a
// 2D-TILED DATA TEXTURE: element i lives at texel (i % W, i / W), which is exactly
// where shader-dsl's storage→data-texture pre-pass reads it (`storageFetch*` →
// `texelFetch(t, ivec2(i % textureSize(t,0).x, i / textureSize(t,0).x), 0).r`). W is
// capped at 2048 — the guaranteed-safe WebGL2 MAX_TEXTURE_SIZE floor — so an array of
// any length wraps across rows, and the shader reads the real width via textureSize()
// rather than a compile-time constant that would need syncing.
//
// Extracted from rhi-webgl2.ts (#1703) when the element axis arrived: the create/write
// pair, the format table, and the view rule are ONE concern, and the LOC ratchet is
// right that the device file should not absorb it.
//
// THE CONTRACT THAT CANNOT FAIL LOUDLY: the texture's internal format must match the
// SAMPLER the emitted GLSL declares — `array<f32>` → `sampler2D` (R32F), `array<u32>` →
// `usampler2D` (R32UI), `array<i32>` → `isampler2D` (R32I). A mismatch does not raise:
// the texture is merely INCOMPLETE, and texelFetch on an incomplete texture silently
// returns 0. That is the same class as the #823 stale-LINEAR-sampler bug, and it is why
// `elem` is carried on the buffer rather than inferred per write.

/** The element a storage data texture carries. Mirrors `RhiBufferDesc.elem`. */
export type StorageElem = 'f32' | 'u32' | 'i32'

/** A 'storage' RHI buffer as WebGL2 actually holds it: a data texture, not a buffer. */
export interface Gl2StorageBuffer {
  storageTex: WebGLTexture
  width: number
  height: number
  size: number
  /** Chosen at CREATE time and remembered, so writeBuffer uploads through the matching
   *  typed array + GL format. The two must agree or the upload is a GL error — and the
   *  texture/sampler mismatch it would paper over is a silent zero read. */
  elem: StorageElem
}

/** The GL triple per element. R32F sampling is core WebGL2 (rendering TO it needs
 *  EXT_color_buffer_float, but the emulation only ever samples); R32UI/R32I are core
 *  texturable integer formats, likewise extension-free. All three are unfilterable,
 *  which is exactly right — the emulation only texelFetch()es, and shader-dsl refuses
 *  filtered reads of the integer ones outright (#1703). */
const FORMAT = {
  f32: { internal: 'R32F', format: 'RED', type: 'FLOAT' },
  u32: { internal: 'R32UI', format: 'RED_INTEGER', type: 'UNSIGNED_INT' },
  i32: { internal: 'R32I', format: 'RED_INTEGER', type: 'INT' },
} as const

/** A typed view of `cap` elements over `buf` matching `elem`. WebGL2 requires
 *  texSubImage2D's typed array to MATCH its `type` argument exactly — a Uint32Array
 *  with gl.FLOAT is an INVALID_OPERATION — so the view is built from the TEXTURE's
 *  element, never from whatever the caller happened to hand in. */
const texView = (
  elem: StorageElem,
  buf: ArrayBuffer,
  byteOffset: number,
  cap: number,
): ArrayBufferView =>
  elem === 'u32'
    ? new Uint32Array(buf, byteOffset, cap)
    : elem === 'i32'
      ? new Int32Array(buf, byteOffset, cap)
      : new Float32Array(buf, byteOffset, cap)

// Byte-addressed: one scratch backs f32/u32/i32 alike, since all three are 4-byte words
// and the padding below is a pure byte move. Lazily grown, reused across writes (#784 —
// this used to allocate a fresh array per write).
let _padScratch = new ArrayBuffer(0)

/** Allocate the data texture backing one 'storage' buffer of `size` bytes. */
export function createStorageDataTexture(
  gl: WebGL2RenderingContext,
  size: number,
  elem: StorageElem,
): Gl2StorageBuffer {
  const fmt = FORMAT[elem]
  const tex = gl.createTexture()
  if (!tex) throw new Error('webgl2: createTexture (storage) failed')
  const texels = Math.max(1, Math.ceil(size / 4))
  const width = Math.min(texels, 2048)
  const height = Math.ceil(texels / width)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl[fmt.internal],
    width,
    height,
    0,
    gl[fmt.format],
    gl[fmt.type],
    null,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return { storageTex: tex, width, height, size, elem }
}

/** Upload `data` into the W×H data texture, row-major (texel (i%W, i/W) = data[i]).
 *  Padded to the full W*H so the texSubImage covers the whole texture; a partial last
 *  row reads 0 past the array end. byteOffset 0 = whole-array write (the storage-buffer
 *  case).
 *
 *  The pad/copy runs on a Uint32Array WORD view whatever the element is: all three are
 *  4-byte words, so it is a pure byte move and the f32 path's uploaded bytes are
 *  unchanged by #1703. Only the final view + GL format/type INTERPRET those bytes, and
 *  both come from the texture's own element.
 *
 *  The word view MUST honour the caller's view WINDOW (byteOffset + byteLength), not its
 *  whole backing buffer. Every real caller here hands in a FRAME-ARENA subarray —
 *  `FrameArena.allocF32` returns `new Float32Array(this.buffer, off, count)` — so
 *  `data.buffer` is one large arena shared by every renderer that frame. Reading it from
 *  offset 0 uploads a different buffer's bytes, with no error anywhere: the draw simply
 *  renders nothing. That is exactly what a `new Uint32Array(data.buffer)` here did to the
 *  WebGL2 point path (caught by _1616-pan-points-gl2-gate: 0 red pixels where >2000 were
 *  expected). The pre-#1703 code was safe by accident — it passed a Float32Array straight
 *  through, window intact, and only rebuilt a view for the non-f32 case. */
export function writeStorageDataTexture(
  gl: WebGL2RenderingContext,
  b: Gl2StorageBuffer,
  byteOffset: number,
  data: BufferSource,
): void {
  const fmt = FORMAT[b.elem]
  const view = data instanceof ArrayBuffer ? undefined : (data as ArrayBufferView)
  const srcBuf = view ? view.buffer : (data as ArrayBuffer)
  const srcOff = view ? view.byteOffset : 0
  const words = new Uint32Array(srcBuf, srcOff, (view ? view.byteLength : srcBuf.byteLength) >>> 2)
  const cap = b.width * b.height
  let padded: ArrayBufferView
  if (words.length === cap) {
    padded = texView(b.elem, srcBuf, srcOff, cap)
  } else {
    if (cap * 4 > _padScratch.byteLength) _padScratch = new ArrayBuffer(cap * 8)
    const dst = new Uint32Array(_padScratch, 0, cap)
    dst.fill(0)
    dst.set(words.subarray(0, Math.min(words.length, cap)), byteOffset / 4)
    padded = texView(b.elem, _padScratch, 0, cap)
  }
  gl.bindTexture(gl.TEXTURE_2D, b.storageTex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, b.width, b.height, gl[fmt.format], gl[fmt.type], padded)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4) // restore the GL default (#1049 hygiene)
}
