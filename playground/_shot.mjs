import { chromium } from '/home/user/X-GIS/node_modules/.bun/playwright-core@1.60.0/node_modules/playwright-core/index.mjs'
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
const ROOT = '/home/user/X-GIS/site/dist'
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
}
const srv = createServer((req, res) => {
  let p = join(ROOT, decodeURIComponent(req.url.split('?')[0]))
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html')
  if (!existsSync(p)) {
    res.writeHead(404)
    return res.end('nf')
  }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
  res.end(readFileSync(p))
})
await new Promise((r) => srv.listen(4321, r))
const b = await chromium.launch({ executablePath: process.env.XGIS_CHROMIUM_EXECUTABLE })
const pg = await b.newPage({ viewport: { width: 1440, height: 1400 } })
for (const [name, url] of Object.entries({
  symbol: 'http://localhost:4321/api/index/functions/emitConst/',
  index: 'http://localhost:4321/api/index/',
})) {
  await pg.goto(url, { waitUntil: 'networkidle' })
  await pg.screenshot({
    path: `/tmp/claude-0/-home-user-X-GIS/4baaab06-272e-5f82-b926-ccff9ed8611d/scratchpad/before-${name}.png`,
    fullPage: false,
  })
}
await b.close()
srv.close()
console.log('shots done')
