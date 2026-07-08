// ═══ Retained-icon packer (#797 Phase 1) ═══
//
// Turns an IconDrawSpec into the two GPU-bound typed arrays the retained-icon
// shader reads: the `feat` buffer (position DSFUN + quad geometry, ICON_RETAINED_FEAT
// layout) and the `tint` buffer (rgba per instance). Every accessor runs EXACTLY
// ONCE here — this function is called from add()/update(), NEVER from the render
// path — so a camera move does zero per-instance CPU work (the N-independence
// thesis). Position packing reuses the SAME ECEF/Mercator DSFUN math as the point
// packer, so the shader's reused geo→clip ladder applies unchanged.

import { lonLatToECEF } from '@xgis/shared'
import { worldCopyMercX } from '../render/point-feature-packer'
import { parseHexColor } from '../feature-helpers'
import { EARTH, xlog } from '@xgis/shared'
import type { SpriteInfo } from '../sprite/sprite-atlas-host'
import {
  ICON_RETAINED_FEAT,
  ICON_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/icon-retained-feat-layout'
import type { IconDrawSpec, IconColor, IconAnchor, Position, Packed } from './graphics-types'

const F = ICON_RETAINED_FEAT.slot
const STRIDE = ICON_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
const MERC_LAT_LIMIT = 85.051129
const R_MERC = EARTH.sphereR // web-Mercator sphere radius (matches the point packer)

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

/** Resolve a `Packed<T,D>` accessor for item `i` — a function runs ONCE, a
 *  constant is returned as-is. Never invoked per frame. */
function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

/** Normalise an IconColor to an rgba tuple in 0..1 (default white = identity). */
function normColor(c: IconColor | undefined): [number, number, number, number] {
  if (c === undefined) return [1, 1, 1, 1]
  if (typeof c === 'string') {
    const parsed = parseHexColor(c)
    return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : [1, 1, 1, 1]
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

/** Pack the per-instance `tint` buffer (rgba). Runs getColor once per item. */
export function packRetainedIconTint<D>(spec: IconDrawSpec<D>): Float32Array {
  const data = spec.data
  const n = data.length
  const tint = new Float32Array(n * ICON_RETAINED_TINT_STRIDE)
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = normColor(resolve(spec.getColor, data[i]!, i))
    const o = i * ICON_RETAINED_TINT_STRIDE
    tint[o] = r
    tint[o + 1] = g
    tint[o + 2] = b
    tint[o + 3] = a
  }
  return tint
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
    const ecef = lonLatToECEF(lon, lat)
    const exH = Math.fround(ecef[0])
    const eyH = Math.fround(ecef[1])
    const ezH = Math.fround(ecef[2])
    feat[o + F.ecef_x_h] = exH
    feat[o + F.ecef_y_h] = eyH
    feat[o + F.ecef_z_h] = ezH
    feat[o + F.ecef_x_l] = ecef[0] - exH
    feat[o + F.ecef_y_l] = ecef[1] - eyH
    feat[o + F.ecef_z_l] = ecef[2] - ezH
    feat[o + F.abs_lon] = lon
    feat[o + F.abs_lat] = lat
    // Baked at world copy 0 (worldCopyMercX = the shared point-packer authority);
    // the shader adds the per-copy world_offset uniform for the flat-Mercator wrap.
    const mx = worldCopyMercX(lon, 0)
    const latC = Math.max(-MERC_LAT_LIMIT, Math.min(MERC_LAT_LIMIT, lat))
    const my = Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * R_MERC
    const mxH = Math.fround(mx)
    const myH = Math.fround(my)
    feat[o + F.merc_x_h] = mxH
    feat[o + F.merc_x_l] = Math.fround(mx - mxH)
    feat[o + F.merc_y_h] = myH
    feat[o + F.merc_y_l] = Math.fround(my - myH)

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
