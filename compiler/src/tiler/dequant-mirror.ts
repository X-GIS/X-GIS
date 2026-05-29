// CPU mirror of the GPU `dequant_ecef` shader fn (runtime polygon.ts). Two
// decoders of the stride-24 quantized buffer (u16×6 position in the first 12
// bytes + f32 tail):
//
//   - dequantVertex     — f64 (Math.* with no fround). The ENCODER's intent /
//     upper bound: measures the u16×6 QUANTIZATION grid error alone, NOT what
//     the GPU achieves.
//   - dequantVertexF32  — Math.fround after every op = WGSL f32 semantics. The
//     TRUE end-to-end precision the shader reaches (q reaches ~2^32, past f32's
//     2^24 exact-integer limit, so the low u16 lane is largely swallowed).
//
// dequantVertexF32 is the CPU side of the compute parity gate: the harness runs
// the REAL dequant_ecef in a SwiftShader compute pass and asserts its f32 output
// equals this mirror — proving the CPU model faithfully represents GPU f32. It
// is also the honest precision oracle for ecef-precision-fuzz.

export interface QuantizedDecode {
  vertices: Float32Array
  dequantScale: number
  dequantHalf: number
}

/** f64 decode — quantization-grid error only (encoder intent). NOT the GPU. */
export function dequantVertex(quant: QuantizedDecode, vi: number): [number, number, number] {
  const u16 = new Uint16Array(quant.vertices.buffer, quant.vertices.byteOffset)
  const u = vi * 12
  const ax = (u16[u]! * 65536 + u16[u + 1]!) * quant.dequantScale - quant.dequantHalf
  const ay = (u16[u + 2]! * 65536 + u16[u + 3]!) * quant.dequantScale - quant.dequantHalf
  const az = (u16[u + 4]! * 65536 + u16[u + 5]!) * quant.dequantScale - quant.dequantHalf
  return [ax, ay, az]
}

/** f32 decode — Math.fround models the GPU's WGSL arithmetic exactly:
 *    q    = f32( f32(f32(hi) * f32(65536)) + f32(lo) )
 *    axis = f32( f32(q * f32(scale)) - f32(half) )
 *  Validated against the real GPU by the compute parity harness. */
export function dequantVertexF32(quant: QuantizedDecode, vi: number): [number, number, number] {
  const f = Math.fround
  const u16 = new Uint16Array(quant.vertices.buffer, quant.vertices.byteOffset)
  const u = vi * 12
  const scale = f(quant.dequantScale)
  const half = f(quant.dequantHalf)
  const axis = (hi: number, lo: number): number => {
    const q = f(f(f(hi) * f(65536)) + f(lo))
    return f(f(q * scale) - half)
  }
  return [
    axis(u16[u]!, u16[u + 1]!),
    axis(u16[u + 2]!, u16[u + 3]!),
    axis(u16[u + 4]!, u16[u + 5]!),
  ]
}
