// ═══ Retained-icon packer (#797 Phase 1) ═══
//
// Turns an IconDrawSpec into the two GPU-bound typed arrays the retained-icon
// shader reads: the `feat` buffer (position DSFUN + quad geometry, ICON_RETAINED_FEAT
// layout) and the `tint` buffer (rgba per instance). Every accessor runs EXACTLY
// ONCE here — this function is called from add()/update(), NEVER from the render
// path — so a camera move does zero per-instance CPU work (the N-independence
// thesis). Position packing reuses the SAME ECEF/Mercator DSFUN math as the point
// packer, so the shader's reused geo→clip ladder applies unchanged.

import { xlog } from '@xgis/shared'
import { WHITE_RGBA, packGeoPointDsfun, packRetainedTint, resolve } from './retained-pack-common'
import type { SpriteInfo } from '../sprite/sprite-atlas-host'
import { ICON_RETAINED_FEAT } from '../shaders/dsl/icon-retained-feat-layout'
import type { IconDrawSpec, IconAnchor, Position } from './graphics-types'

const F = ICON_RETAINED_FEAT.slot
const STRIDE = ICON_RETAINED_FEAT.stride

/** The minimal atlas surface the packer resolves sprite UV rects through. */
export interface PackerAtlas {
  get(name: string): SpriteInfo | undefined
  size(): { width: number; height: number }
}

const ANCHOR_MODE: Record<IconAnchor, number> = {
  center: 0,
  top: 1,
  bottom: 2,
  left: 3,
  right: 4,
  'top-left': 5,
  'top-right': 6,
  'bottom-left': 7,
  'bottom-right': 8,
}

/** Pack the per-instance `tint` buffer (rgba). Runs getColor once per item. */
export function packRetainedIconTint<D>(spec: IconDrawSpec<D>): Float32Array {
  return packRetainedTint(spec.data, spec.getColor, WHITE_RGBA)
}

/** Pack the per-instance `feat` buffer (position DSFUN + quad geometry). Runs
 *  getPosition / getImage / getSize / getRotation once per item; `dpr` scales the
 *  pixel size to physical px (same convention as the screen-px icon path).
 *  A name with no resolved sprite packs a zero-size (invisible) instance + warns
 *  once, keeping instance_index aligned with the data index. */
export function packRetainedIconFeat<D>(
  spec: IconDrawSpec<D>,
  atlas: PackerAtlas,
  dpr: number,
): Float32Array {
  const data = spec.data
  const n = data.length
  const feat = new Float32Array(n * STRIDE)
  const anchorMode = ANCHOR_MODE[spec.anchor ?? 'center']
  const { width: atlasW, height: atlasH } = atlas.size()
  const warned = new Set<string>()

  for (let i = 0; i < n; i++) {
    const d = data[i]!
    const o = i * STRIDE

    // ── Position → ECEF + Mercator DSFUN (mirrors point-feature-packer). ──
    const pos = resolve<Position, D>(spec.getPosition, d, i)
    const lon = pos ? pos[0] : 0
    const lat = pos ? pos[1] : 0
    packGeoPointDsfun(feat, o + F.ecef_x_h, lon, lat)

    // ── Sprite UV rect + pixel size. ──
    const name = resolve<string, D>(spec.getImage, d, i)
    const sprite = name !== undefined ? atlas.get(name) : undefined
    if (!sprite) {
      if (name !== undefined && !warned.has(name)) {
        warned.add(name)
        xlog.warn(`[X-GIS graphics] add: no registered image "${name}" — icon skipped`)
      }
      // zero-size instance stays invisible; leave uv/size at 0.
      feat[o + F.anchor_mode] = anchorMode
      continue
    }
    const scale = resolve<number, D>(spec.getSize, d, i) ?? 1
    const designW = sprite.width / sprite.pixelRatio
    const designH = sprite.height / sprite.pixelRatio
    feat[o + F.size_w] = designW * scale * dpr
    feat[o + F.size_h] = designH * scale * dpr
    feat[o + F.u0] = sprite.x / atlasW
    feat[o + F.v0] = sprite.y / atlasH
    feat[o + F.u1] = (sprite.x + sprite.width) / atlasW
    feat[o + F.v1] = (sprite.y + sprite.height) / atlasH
    feat[o + F.rot_rad] = resolve<number, D>(spec.getRotation, d, i) ?? 0
    feat[o + F.anchor_mode] = anchorMode
  }
  return feat
}
