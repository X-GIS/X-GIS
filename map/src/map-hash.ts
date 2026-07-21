// ═══ URL hash camera sync (#1268) — shareable "you are here" links ═══
//
// MapLibre-style `#zoom/lat/lon[/bearing[/pitch]]` fragment. Pure format/parse
// helpers live here (unit-proved); XGISMap owns the boot-seed + debounced
// move-end write + listener lifecycle. `hash: true` writes the bare fragment;
// `hash: 'name'` namespaces it as `name=…` so several maps on one page (or a
// host app's own fragment params) coexist without clobbering each other.

export interface HashCameraState {
  zoom: number
  lon: number
  lat: number
  bearing: number
  pitch: number
}

/** Decimal places for lat/lon at a given zoom. deg/pixel = 360/(512·2^zoom),
 *  so `ceil(0.3·zoom)+2` keeps a round-trip sub-pixel-exact (the acceptance's
 *  "restores the exact view") while low-zoom links stay short. Bounded [2,10]. */
function lonLatDigits(zoom: number): number {
  return Math.min(10, Math.max(2, Math.ceil(zoom * 0.3) + 2))
}

function round(v: number, digits: number): number {
  const m = Math.pow(10, digits)
  return Math.round(v * m) / m
}

/** Format the camera as the BARE fragment value `zoom/lat/lon`, appending
 *  `/bearing` when bearing≠0 and `/bearing/pitch` when pitch≠0 (a pitch always
 *  carries its bearing slot, matching MapLibre). Namespacing + merging into an
 *  existing fragment is `updateHashFragment`'s job. */
export function formatHash(cam: HashCameraState): string {
  const z = Math.round(cam.zoom * 100) / 100
  const d = lonLatDigits(z)
  const lat = round(cam.lat, d)
  const lon = round(cam.lon, d)
  const bearing = Math.round(cam.bearing * 10) / 10
  const pitch = Math.round(cam.pitch * 10) / 10
  let out = `${z}/${lat}/${lon}`
  if (bearing !== 0 || pitch !== 0) out += `/${bearing}`
  if (pitch !== 0) out += `/${pitch}`
  return out
}

/** Parse a URL fragment (with or without the leading `#`) into a camera state,
 *  or null when it doesn't match the expected shape — a foreign/empty fragment
 *  is IGNORED, never throws, and never drives the camera to a wild place.
 *  `ns` non-empty reads only the `ns=…` segment (among any `&`-joined params). */
export function parseHash(fragment: string, ns: string): HashCameraState | null {
  let s = fragment.replace(/^#/, '')
  if (ns !== '') {
    const prefix = `${ns}=`
    const seg = s.split('&').find((p) => p.startsWith(prefix))
    if (seg === undefined) return null
    s = seg.slice(prefix.length)
  }
  const parts = s.split('/')
  if (parts.length < 3 || parts.length > 5) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  const [zoom, lat, lon, bearing = 0, pitch = 0] = nums as [
    number,
    number,
    number,
    number?,
    number?,
  ]
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { zoom, lon, lat, bearing, pitch }
}

/** Build the new fragment string (without `#`) that writes `value` under `ns`.
 *  Unnamespaced (`ns===''`) OWNS the whole fragment. Namespaced merges: the
 *  `ns=…` segment is replaced/appended among any OTHER `&`-joined params so a
 *  sibling map (distinct namespace) or a host param survives the write. */
export function updateHashFragment(current: string, ns: string, value: string): string {
  if (ns === '') return value
  const prefix = `${ns}=`
  const kept = current
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p !== '' && !p.startsWith(prefix))
  kept.push(`${prefix}${value}`)
  return kept.join('&')
}
