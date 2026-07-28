// ═══ Where each S-111 catalogue arrow currently IS (#1409) ═══
//
// The catalogue arrow is the particle. Not a dot drawn beside it, not a trail behind it — the
// SCAROW glyph itself drifts through the current, and at whatever position it reaches it is
// re-symbolized from the data under it (band colour, rotation, scale — `s111BandTable`). This
// module owns the one piece of state that makes that possible: one texel per arrow, holding
// that arrow's position in the coverage's own grid-uv space.
//
// The velocity pair (`flowU`/`flowV`, coverage-renderer.ts) is DATA — it says how fast the
// water moves and nothing more. It is never drawn. What it does is move these positions.
//
// WHY A TEXTURE AND NOT A BUFFER. Updating positions on the GPU inside a RENDER pass means the
// update is a fragment shader, and a fragment shader writes to a colour attachment. So the
// state lives in a texture, is read as a texture by the next update, and is read AGAIN by the
// arrow draw's VERTEX stage. The alternative — a compute pass — is closed off by #1046 (no
// backend fork, no compute dependency): WebGL2 has no compute, and a WebGPU-only motion layer
// would be a fork by another name.
//
// WHY NOT ON THE CPU. The existing generator (`coverage-arrow-show.ts`) evaluates the catalogue
// rule per cell on the CPU and uploads a packed instance buffer. Doing that EVERY FRAME is what
// this replaces: one full regeneration already measured ~27 ms on a 596×433 CBOFS grid (#67 —
// reported as a playback stutter), so a per-frame repack is not a slower option, it is a
// non-option.
//
// WHY rgba8unorm AND NOT A FLOAT FORMAT. Rendering into a half-float attachment on WebGL2 needs
// EXT_color_buffer_float; rgba8unorm is core in both backends and cannot fail. Eight bits is
// nowhere near enough for a position, so each axis is stored across TWO channels as a 16-bit
// fixed-point value (`encodeArrowPosition` and its shader twin) — 1/65535 of the grid span,
// which on a 596-cell CBOFS row is ~1/110 of a cell, far below anything visible.
//
// The pair does not resize with the coverage's GEOMETRY. A position is normalized grid-uv, so a
// different grid re-interprets the SAME numbers against the new footprint — no reallocation, no
// reseed, and a forecast step keeps the motion continuous instead of restarting it. It DOES
// resize with the arrow COUNT (#1450 A), which is a different question and the reason the two
// are stated apart: same count on a new grid keeps drifting; a different count is a different
// set of arrows per texel, and that one re-seeds.

import type { RhiDevice, RhiTexture, RhiTextureView } from '@xgis/engine'

/** Upper bound on arrows in flight — the SAME ceiling the static portrayal has always used
 *  (`COVERAGE_ARROW_MAX`), restated here because this module cannot import from the map root.
 *  A global field (#1273) wants GPU instance generation rather than a bigger texture, so the
 *  bound stays; what changed is its VALUE, and why.
 *
 *  THE REVERSAL (#1450 A). This was a fixed 128² = 16 384, argued as a DISPLAY choice
 *  deliberately not bound to the cell count: a drifting symbol is not at a grid position
 *  anyway, and binding it to the data would make a global field unaffordable while making a
 *  small harbour look sparse. Both halves of that still hold on their own terms — but they
 *  were reasoning about a field drawn BESIDE the catalogue portrayal, and the advected field
 *  is now the one that REPLACES it (#1449). Two densities for one portrayal is what shipped:
 *  the static path emits one arrow per water cell up to 100 000, this one capped at 16 384, so
 *  a CBOFS cell (≈ 69 700 valid) came out at stride 1 against stride 5 — different cells,
 *  different bands, visibly different colours from the first frame.
 *
 *  So the count follows the batch, bounded by the ceiling the static path already trusts. The
 *  sparse-harbour half of the old argument is unaffected (a small grid gets its own cells,
 *  which is exactly one symbol per position — the catalogue's own rule); the affordability
 *  half is preserved by the bound rather than by a fixed size. */
export const ARROW_ADVECT_MAX_COUNT = 100_000

/** The square state-texture edge holding `count` arrows, one texel each.
 *
 *  SQUARE, and the VS agrees by construction: it reads `textureDimensions` and derives its
 *  texel as `(inst % dim.x, inst / dim.x)` (`shaders/dsl/arrow-retained.ts`), so the layout is
 *  never restated on the GPU side and a resize needs no shader change at all. */
export function arrowAdvectDim(count: number): number {
  const n = Math.min(Math.max(0, Math.floor(count)), ARROW_ADVECT_MAX_COUNT)
  return n <= 0 ? 0 : Math.ceil(Math.sqrt(n))
}

/** Pack a grid-uv coordinate pair into the rgba8 layout the shaders agree on: r/g carry the LOW
 *  byte of x/y, b/a the HIGH byte. Kept next to the seed that writes it so the CPU seed and the
 *  GPU update cannot drift into two different encodings — that failure produces arrows which
 *  advect correctly and are DRAWN somewhere else, which looks like a placement bug rather than
 *  an encoding one. */
export function encodeArrowPosition(x: number, y: number, out: Uint8Array, at: number): void {
  const cx = Math.max(0, Math.min(0.999999, x)) * 255
  const cy = Math.max(0, Math.min(0.999999, y)) * 255
  const hiX = Math.floor(cx)
  const hiY = Math.floor(cy)
  out[at] = Math.round((cx - hiX) * 255) // r — x low
  out[at + 1] = Math.round((cy - hiY) * 255) // g — y low
  out[at + 2] = hiX // b — x high
  out[at + 3] = hiY // a — y high
}

/** The inverse, for tests and readback. Mirrors the shader's `decode_arrow_pos` exactly:
 *  value = high/255 + low/(255·255). */
export function decodeArrowPosition(r: number, g: number, b: number, a: number): [number, number] {
  return [b / 255 + r / 65025, a / 255 + g / 65025]
}

/** Deterministic scatter for the initial state. A FIXED sequence rather than Math.random(): a
 *  render gate that reads pixels needs the same starting field on every run, and "the arrows
 *  begin somewhere plausible" is not a property worth non-determinism. */
export function seedArrowPositions(count: number): Uint8Array {
  const bytes = new Uint8Array(count * 4)
  // A 2D low-discrepancy sequence (R₂ / plastic constant) — spreads without the clumping a
  // plain LCG shows at these counts, and needs no state beyond the index. Written at the
  // precision f64 actually carries: the constant's full decimal expansion
  // (1.32471795724474602596…) rounds to this on load, so spelling the extra digits would only
  // claim a precision the runtime discards.
  const g = 1.324717957244746
  const a1 = 1 / g
  const a2 = 1 / (g * g)
  for (let i = 0; i < count; i++) {
    encodeArrowPosition((0.5 + a1 * (i + 1)) % 1, (0.5 + a2 * (i + 1)) % 1, bytes, i * 4)
  }
  return bytes
}

/** Owns the arrow-position ping-pong. Mirrors FlowTargets' lifecycle — lazy, device-swap
 *  self-healing, destroyed with the map — and a FIXED format, so it has no format agreement to
 *  keep. The SIZE follows the batch (#1450 A); a resize re-seeds, which is why it is driven
 *  from `writeOrigins` (the one call that knows the count) rather than from the per-frame step. */
export class ArrowAdvectState {
  private a: RhiTexture | null = null
  private b: RhiTexture | null = null
  private aView: RhiTextureView | null = null
  private bView: RhiTextureView | null = null
  private origin: RhiTexture | null = null
  private originV: RhiTextureView | null = null
  private originKey = ''
  private flipped = false
  private device: RhiDevice | null = null
  /** The allocated square edge, and the count it was sized for. 0 = nothing allocated. */
  private dim = 0
  private count = 0

  /** What this frame's update reads FROM, and what the arrow draw's vertex stage reads. */
  get readView(): RhiTextureView | null {
    return this.flipped ? this.bView : this.aView
  }

  /** What this frame's update writes INTO. */
  get writeView(): RhiTextureView | null {
    return this.flipped ? this.aView : this.bView
  }

  /** Where each arrow BELONGS — texel `i` is instance `i`'s origin cell in grid-uv, in the same
   *  rgba8 encoding as the position pair. Null until `writeOrigins`. Read by the advect step
   *  (to leash and to recycle an arrow back to its own cell) and by the arrow VS (the
   *  displacement it draws is position − origin), so there is ONE copy of the origins and no
   *  chance of the two stages disagreeing about where an arrow started. */
  get originView(): RhiTextureView | null {
    return this.originV
  }

  /** Exchange the sides — once per update, AFTER the draw that used them. */
  swap(): void {
    this.flipped = !this.flipped
  }

  /** Upload the origins for the current arrow batch, and start every arrow AT its origin.
   *
   *  `key` identifies the batch's instance layout (region + grid size + count): an equal key
   *  means origin `i` still belongs to instance `i`, so the upload is SKIPPED and the arrows
   *  keep drifting. That is what makes a forecast step continuous — the data under the arrows
   *  is replaced, the arrows themselves do not jump back to their cells. An unequal key is a
   *  different instance set, where a stale position is a position belonging to another arrow.
   *
   *  Seeding the positions FROM the origins (rather than from `seedArrowPositions`) buys a
   *  property the render gate uses: on frame 0 the advected field is EXACTLY the static
   *  catalogue placement, so "the arrows moved" is a comparison against the portrayal itself. */
  writeOrigins(rhi: RhiDevice, key: string, u: ArrayLike<number>, v: ArrayLike<number>): void {
    // The COUNT drives the allocation (#1450 A), so this is also where a resize happens — and
    // a resize necessarily re-seeds, which is why the key check comes after it.
    this.ensure(rhi, Math.min(u.length, v.length))
    if (!this.a) return // an empty batch allocates nothing
    if (key === this.originKey) return
    this.originKey = key
    const dim = this.dim
    const bytes = new Uint8Array(dim * dim * 4)
    const n = Math.min(u.length, v.length, dim * dim)
    for (let i = 0; i < n; i++) encodeArrowPosition(u[i]!, v[i]!, bytes, i * 4)
    // Texels past the instance count keep (0,0) — the edge is `ceil(sqrt(n))`, so there are at
    // most `2·sqrt(n)` of them. No instance reads them, and the advect step stepping them is
    // harmless: it is a whole-texture pass either way.
    const row = dim * 4
    rhi.writeTexture(this.origin!, bytes, row, dim, dim)
    rhi.writeTexture(this.a, bytes, row, dim, dim)
    rhi.writeTexture(this.b!, bytes, row, dim, dim)
    this.flipped = false
  }

  /** Allocate the pair on first use, and SEED it. Unlike a trail buffer there is no
   *  `needsClear` obligation handed to a caller: a cleared position state is not merely ugly,
   *  it is degenerate — every arrow stacked at grid-uv (0,0) forever — so the seed is written
   *  here, at the only moment it could be missed. */
  ensure(rhi: RhiDevice, count = this.count): void {
    if (rhi !== this.device) {
      // A new device took the old textures with it. Drop the handles WITHOUT destroying them
      // (destroying through a dead device is the #737 hazard) and fall through to reallocate.
      this.device = rhi
      this.a = this.b = this.origin = null
      this.aView = this.bView = this.originV = null
      // The origins went with the old device, so the next writeOrigins must re-upload them
      // even though the batch did not change.
      this.originKey = ''
      // Not the COUNT though: the batch is the same one, so a bare `ensure(rhi)` from the
      // per-frame step re-allocates at the size it was already using rather than at nothing.
      this.dim = 0
    }
    const dim = arrowAdvectDim(count)
    if (this.a && dim === this.dim) return
    // A resize frees the old trio first — the pair is the largest thing this owns, and holding
    // both while the new one uploads doubles it for no reason.
    if (this.a) this.free()
    this.count = count
    this.dim = dim
    if (dim === 0) return // no arrows: allocate nothing rather than a 1×1 nobody reads
    this.a = this.make(rhi, 'arrow-advect-a', dim)
    this.b = this.make(rhi, 'arrow-advect-b', dim)
    this.origin = this.make(rhi, 'arrow-advect-origin', dim)
    this.aView = rhi.createView(this.a)
    this.bView = rhi.createView(this.b)
    this.originV = rhi.createView(this.origin)
    this.flipped = false
    // The positions are about to be re-seeded at a different size, so whatever origins the old
    // texture held cannot be reused — say so, or `writeOrigins` skips the upload on an equal key
    // and every arrow reads (0,0).
    this.originKey = ''
    // Seed BOTH sides. Only the read side is strictly needed, but the write side's undefined
    // contents would be visible for exactly one frame as a flash of arrows at garbage positions.
    const seed = seedArrowPositions(dim * dim)
    rhi.writeTexture(this.a, seed, dim * 4, dim, dim)
    rhi.writeTexture(this.b, seed, dim * 4, dim, dim)
  }

  destroy(): void {
    this.free()
    this.device = null
    this.count = 0
  }

  /** Release the trio, keeping the device — the shared half of `destroy` and a resize. */
  private free(): void {
    if (this.a) this.device?.destroyTexture(this.a)
    if (this.b) this.device?.destroyTexture(this.b)
    if (this.origin) this.device?.destroyTexture(this.origin)
    this.a = this.b = this.origin = null
    this.aView = this.bView = this.originV = null
    this.originKey = ''
    this.flipped = false
    this.dim = 0
  }

  private make(rhi: RhiDevice, label: string, dim: number): RhiTexture {
    return rhi.createTexture({
      width: dim,
      height: dim,
      format: 'rgba8unorm',
      // `render` so the update can write it, `sample` so the next update AND the arrow draw's
      // vertex stage can read it (both sides need both — they alternate roles every frame), and
      // `copy-dst` because THIS MODULE SEEDS THEM WITH writeTexture: the initial scatter in
      // `ensure` and every `writeOrigins` upload are queue writes, which WebGPU validates
      // against the usage flags.
      //
      // Its absence was a WebGPU-only crash — "Usage (TextureBinding|RenderAttachment) of
      // [Texture "arrow-advect-a"] doesn't include TextureUsage::CopyDst, while calling
      // Queue.WriteTexture" — and invisible to the headless render gate, because WebGL2 has no
      // usage validation at all: the same call simply works there. A texture this module writes
      // must declare that it is written.
      usage: ['render', 'sample', 'copy-dst'],
      label,
    })
  }
}
