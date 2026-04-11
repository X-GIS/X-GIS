// ═══ Demo Runner ═══

import { XGISMap } from '@xgis/runtime'
import { DEMOS } from './demos'

const params = new URLSearchParams(location.search)
const demoId = params.get('id') ?? 'minimal'
const demo = DEMOS[demoId]

if (!demo) {
  document.body.innerHTML = `
    <div style="padding:3rem;text-align:center">
      <p style="color:#e74c3c;font-size:1.1rem">Unknown demo: "${demoId}"</p>
      <a href="/" style="color:#60a5fa;margin-top:1rem;display:inline-block">&larr; Back to demos</a>
    </div>
  `
} else {
  const canvas = document.getElementById('map') as HTMLCanvasElement
  const status = document.getElementById('status')!
  const errorDiv = document.getElementById('error')!
  const errorMsg = document.getElementById('error-msg')!
  const sourceEl = document.getElementById('source-code')!
  const titleEl = document.getElementById('demo-title')!
  const descEl = document.getElementById('demo-desc')!

  titleEl.textContent = demo.name
  descEl.textContent = demo.description
  sourceEl.textContent = demo.source.trim()
  document.title = `${demo.name} — X-GIS`

  async function run() {
    try {
      status.textContent = 'Loading...'
      const map = new XGISMap(canvas)
      await map.run(demo.source, '/data/')
      status.textContent = `${demo.name} | scroll to zoom, drag to pan`
      setTimeout(() => { status.style.opacity = '0.5' }, 3000)
    } catch (err) {
      console.error('[X-GIS]', err)
      errorDiv.style.display = 'block'
      errorMsg.textContent = String(err)
      status.textContent = 'Error'
    }
  }

  run()
}
