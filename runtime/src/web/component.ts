// ═══ <xgis-map> Web Component ═══
// HTML에서 바로 X-GIS 코드를 쓸 수 있게 해주는 커스텀 엘리먼트

import { XGISMap } from '../engine/map'

export class XGISMapElement extends HTMLElement {
  private map: XGISMap | null = null
  private canvas: HTMLCanvasElement

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })

    shadow.innerHTML = `
      <style>
        :host { display: block; width: 100%; height: 400px; position: relative; }
        canvas { width: 100%; height: 100%; display: block; }
        .error {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
          background: #1a1a2e; padding: 16px 24px; border-radius: 8px;
          border: 1px solid #e74c3c; color: #ccc; font-size: 13px;
          font-family: monospace; white-space: pre-wrap; display: none;
        }
      </style>
      <canvas></canvas>
      <div class="error"></div>
    `

    this.canvas = shadow.querySelector('canvas')!
  }

  async connectedCallback() {
    this.map = new XGISMap(this.canvas)

    try {
      // 방법 1: src 속성으로 .xgis/.xgb 파일 로드
      const src = this.getAttribute('src')
      if (src) {
        await this.map.load(src) // auto-detect .xgis vs .xgb
        return
      }

      // 방법 2: 인라인 코드 (<xgis-map> 내부 텍스트)
      const inlineCode = this.textContent?.trim()
      if (inlineCode) {
        const baseUrl = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1)
        await this.map.run(inlineCode, baseUrl)
        return
      }

      // 방법 3: script 속성으로 변수 참조
      const scriptId = this.getAttribute('script')
      if (scriptId) {
        const scriptEl = document.getElementById(scriptId)
        if (scriptEl) {
          await this.map.run(scriptEl.textContent ?? '', '')
          return
        }
      }
    } catch (err) {
      const errorDiv = this.shadowRoot!.querySelector('.error') as HTMLDivElement
      errorDiv.style.display = 'block'
      errorDiv.textContent = String(err)
      console.error('[X-GIS]', err)
    }
  }

  disconnectedCallback() {
    this.map?.stop()
  }

  /** Programmatic API: run X-GIS source code */
  async run(source: string, baseUrl = ''): Promise<void> {
    if (!this.map) {
      this.map = new XGISMap(this.canvas)
    }
    await this.map.run(source, baseUrl)
  }
}

// Register the custom element
export function registerXGISElement(): void {
  if (!customElements.get('xgis-map')) {
    customElements.define('xgis-map', XGISMapElement)
  }
}
