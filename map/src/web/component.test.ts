// #2327: <xgis-map> re-attach lifecycle — a disconnect + reconnect (re-parenting,
// framework re-mount) must not leak the first XGISMap. The custom-element contract
// invokes connectedCallback on EVERY attach, so the element must either destroy the
// previous map on disconnect or reuse the live one on reconnect.
//
// No jsdom in this tree: the DOM base class is stubbed BEFORE the module binds
// `HTMLElementBase` (component.ts:15-16), and the lifecycle callbacks are invoked
// directly — exactly what the browser does on append/remove/append.
import { describe, expect, it } from 'vitest'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

describe('<xgis-map> disconnect → reconnect', () => {
  it('does not leak the first XGISMap across a re-attach', async () => {
    const canvas = mockCanvas()
    const errorDiv = { style: {} as CSSStyleDeclaration, textContent: '' }
    const shadow = {
      innerHTML: '',
      querySelector: (sel: string) => (sel === 'canvas' ? canvas : errorDiv),
    }
    class FakeHTMLElement {
      shadowRoot: typeof shadow | null = null
      textContent = ''
      attachShadow(): typeof shadow {
        this.shadowRoot = shadow
        return shadow
      }
      getAttribute(): string | null {
        return null
      }
    }
    ;(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeHTMLElement
    try {
      const { XGISMapElement } = await import('./component')
      const el = new XGISMapElement() as unknown as {
        map: { _destroyed: boolean } | null
        connectedCallback(): Promise<void>
        disconnectedCallback(): void
      }

      await el.connectedCallback() // append → map A
      const first = el.map
      expect(first).not.toBeNull()

      el.disconnectedCallback() // remove()
      await el.connectedCallback() // append again → must NOT construct map B over a live A

      // The first map must be released (destroy()ed) once it is no longer reachable
      // from the element — never left live and unreachable.
      expect(first!._destroyed).toBe(true)
    } finally {
      delete (globalThis as { HTMLElement?: unknown }).HTMLElement
    }
  })
})
