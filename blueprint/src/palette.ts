// The search / contextual-create palette UI. Pure view: the editor
// supplies the candidate items and a pick callback; node creation +
// auto-wiring stay in the editor.

import type { NodeType } from './types'

export interface PaletteItem {
  type: NodeType
  title: string
  blurb: string
  accent: string
  disabled: boolean
}

interface PaletteOpts {
  vpRect: DOMRect
  clientX: number
  clientY: number
  contextual: boolean
  items: PaletteItem[]
  onPick: (t: NodeType) => void
}

export function openSearchPalette(palette: HTMLElement, o: PaletteOpts): void {
  palette.innerHTML = ''
  const search = document.createElement('input')
  search.className = 'bp-ctx-search'
  search.placeholder = o.contextual ? 'Create compatible node…' : 'Search nodes…'
  palette.appendChild(search)
  const list = document.createElement('div')
  list.className = 'bp-ctx-list'
  palette.appendChild(list)

  const render = (q: string) => {
    list.innerHTML = ''
    const ql = q.toLowerCase()
    const matches = o.items.filter(
      (it) => it.title.toLowerCase().includes(ql) || it.blurb.toLowerCase().includes(ql),
    )
    matches.forEach((it, i) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'bp-ctx-item' + (i === 0 ? ' bp-ctx-active' : '')
      item.disabled = it.disabled
      item.innerHTML = `<span class="bp-ctx-dot" style="background:${it.accent}"></span><span><b>${it.title}</b><small>${it.blurb}</small></span>`
      item.addEventListener('click', () => o.onPick(it.type))
      list.appendChild(item)
    })
  }
  render('')
  search.addEventListener('input', () => render(search.value))
  search.addEventListener('keydown', (ev) => {
    const items = [...list.querySelectorAll<HTMLButtonElement>('.bp-ctx-item:not(:disabled)')]
    const cur = list.querySelector('.bp-ctx-active')
    let idx = items.findIndex((x) => x === cur)
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      idx = Math.min(items.length - 1, idx + 1)
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      idx = Math.max(0, idx - 1)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      items[Math.max(0, idx)]?.click()
      return
    } else if (ev.key === 'Escape') {
      palette.style.display = 'none'
      return
    } else return
    items.forEach((x) => x.classList.remove('bp-ctx-active'))
    items[idx]?.classList.add('bp-ctx-active')
    items[idx]?.scrollIntoView({ block: 'nearest' })
  })
  palette.style.left = `${Math.min(o.clientX - o.vpRect.left, o.vpRect.width - 270)}px`
  palette.style.top = `${Math.min(o.clientY - o.vpRect.top, o.vpRect.height - 280)}px`
  palette.style.display = ''
  search.focus()
}
