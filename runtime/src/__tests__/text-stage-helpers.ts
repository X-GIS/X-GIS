// Re-exports the bits of text-stage that are testable without
// WebGPU. Keeps the test file from importing text-stage directly
// (which would pull in TextRenderer's WGSL pipeline + GPU types).

export function applyTextTransformForTesting(
  s: string,
  t?: 'none' | 'uppercase' | 'lowercase',
): string {
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  return s
}
