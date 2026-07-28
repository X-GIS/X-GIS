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
// The pair does NOT resize with the coverage. A position is normalized grid-uv, so a different
// grid re-interprets the SAME numbers against the new footprint — no reallocation, no reseed,
// and a forecast step keeps the motion continuous instead of restarting it.

import type { RhiDevice, RhiTexture, RhiTextureView } from '@xgis/engine'

/** State-texture edge. ARROW_ADVECT_TEX_DIM² arrows are in flight at once.
 *
 *  This is a DISPLAY choice and deliberately NOT the cell count: the catalogue places one
 *  symbol per direct position, but a drifting symbol is not at a grid position anyway, and
 *  binding the count to the data would make a global field (#1273) unaffordable while making a
 *  small harbour look sparse. 128² = 16 384 reads as a full field at any grid size. */
export const ARROW_ADVECT_TEX_DIM = 128

/** How many arrows that dimension implies. */
export const ARROW_ADVECT_COUNT = ARROW_ADVECT_TEX_DIM * ARROW_ADVECT_TEX_DIM

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
 *  self-healing, destroyed with the map — but with a FIXED size and a FIXED format, so it has
 *  no format agreement to keep and no resize path to get wrong. */
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
    this.ensure(rhi)
    if (key === this.originKey) return
    this.originKey = key
    const bytes = new Uint8Array(ARROW_ADVECT_COUNT * 4)
    const n = Math.min(u.length, v.length, ARROW_ADVECT_COUNT)
    for (let i = 0; i < n; i++) encodeArrowPosition(u[i]!, v[i]!, bytes, i * 4)
    // Texels past the instance count keep (0,0). No instance reads them, and the advect step
    // stepping them is harmless — it is a fixed-size pass either way.
    const row = ARROW_ADVECT_TEX_DIM * 4
    rhi.writeTexture(this.origin!, bytes, row, ARROW_ADVECT_TEX_DIM, ARROW_ADVECT_TEX_DIM)
    rhi.writeTexture(this.a!, bytes, row, ARROW_ADVECT_TEX_DIM, ARROW_ADVECT_TEX_DIM)
    rhi.writeTexture(this.b!, bytes, row, ARROW_ADVECT_TEX_DIM, ARROW_ADVECT_TEX_DIM)
    this.flipped = false
  }

  /** Allocate the pair on first use, and SEED it. Unlike a trail buffer there is no
   *  `needsClear` obligation handed to a caller: a cleared position state is not merely ugly,
   *  it is degenerate — every arrow stacked at grid-uv (0,0) forever — so the seed is written
   *  here, at the only moment it could be missed. */
  ensure(rhi: RhiDevice): void {
    if (rhi !== this.device) {
      // A new device took the old textures with it. Drop the handles WITHOUT destroying them
      // (destroying through a dead device is the #737 hazard) and fall through to reallocate.
      this.device = rhi
      this.a = this.b = this.origin = null
      this.aView = this.bView = this.originV = null
      // The origins went with the old device, so the next writeOrigins must re-upload them
      // even though the batch did not change.
      this.originKey = ''
    }
    if (this.a) return
    this.a = this.make(rhi, 'arrow-advect-a')
    this.b = this.make(rhi, 'arrow-advect-b')
    this.origin = this.make(rhi, 'arrow-advect-origin')
    this.aView = rhi.createView(this.a)
    this.bView = rhi.createView(this.b)
    this.originV = rhi.createView(this.origin)
    this.flipped = false
    // Seed BOTH sides. Only the read side is strictly needed, but the write side's undefined
    // contents would be visible for exactly one frame as a flash of arrows at garbage positions.
    const seed = seedArrowPositions(ARROW_ADVECT_COUNT)
    rhi.writeTexture(
      this.a,
      seed,
      ARROW_ADVECT_TEX_DIM * 4,
      ARROW_ADVECT_TEX_DIM,
      ARROW_ADVECT_TEX_DIM,
    )
    rhi.writeTexture(
      this.b,
      seed,
      ARROW_ADVECT_TEX_DIM * 4,
      ARROW_ADVECT_TEX_DIM,
      ARROW_ADVECT_TEX_DIM,
    )
  }

  destroy(): void {
    if (this.a) this.device?.destroyTexture(this.a)
    if (this.b) this.device?.destroyTexture(this.b)
    if (this.origin) this.device?.destroyTexture(this.origin)
    this.a = this.b = this.origin = null
    this.aView = this.bView = this.originV = null
    this.originKey = ''
    this.device = null
    this.flipped = false
  }

  private make(rhi: RhiDevice, label: string): RhiTexture {
    return rhi.createTexture({
      width: ARROW_ADVECT_TEX_DIM,
      height: ARROW_ADVECT_TEX_DIM,
      format: 'rgba8unorm',
      // `render` so the update can write it, `sample` so the next update AND the arrow draw's
      // vertex stage can read it. Both sides need both — they alternate roles every frame.
      usage: ['render', 'sample'],
      label,
    })
  }
}
