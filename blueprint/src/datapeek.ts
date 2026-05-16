// "Peek data" for a GeoJSON source node: fetch and report the
// feature count + first property keys into the given element.

import type { BPNode } from './types'

export async function peekData(n: BPNode, out: HTMLElement): Promise<void> {
  const url = (n.data.url || '').trim()
  if (!url || (n.data.type && n.data.type !== 'geojson')) {
    out.textContent = 'Peek works for geojson sources only.'
    return
  }
  out.textContent = 'Peeking…'
  try {
    const abs = url.startsWith('http') ? url : new URL(url, location.href).href
    const j = await (await fetch(abs)).json()
    const feats = Array.isArray(j.features) ? j.features : Array.isArray(j) ? j : []
    const keys = feats.length && feats[0]?.properties ? Object.keys(feats[0].properties) : []
    out.textContent = `${feats.length} features · ${keys.slice(0, 6).join(', ') || 'no properties'}`
  } catch {
    out.textContent = 'Peek failed (network / CORS).'
  }
}
