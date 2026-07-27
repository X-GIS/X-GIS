// Route every cross-origin request in a Playwright page through the
// Node side, which fetches via `curl` (so a container-level HTTPS_PROXY
// / CA bundle applies) and caches the bytes on disk.
//
// Why: headless Chromium in the cloud dev container cannot reach the
// public internet directly (connection reset) and Playwright's own
// proxy plumbing does not pick up the container proxy. Tile/style/glyph
// bytes still have to arrive for an OFM parity capture, so we fetch
// them out-of-band and fulfil the request from the test process.
//
// Localhost (the Vite dev server) is left untouched.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

export interface OfflineProxyOptions {
  /** Directory for the on-disk byte cache. */
  cacheDir: string
}

const MIME: Record<string, string> = {
  json: 'application/json',
  pbf: 'application/x-protobuf',
  png: 'image/png',
  css: 'text/css',
  js: 'application/javascript',
}

function cacheKey(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

function fetchViaCurl(url: string): Buffer | null {
  try {
    return execFileSync('curl', ['-sSL', '--max-time', '30', '--fail', url], {
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'buffer',
    })
  } catch {
    return null
  }
}

export async function installOfflineProxy(page: Page, opts: OfflineProxyOptions): Promise<void> {
  mkdirSync(opts.cacheDir, { recursive: true })
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) || url.startsWith('data:')) {
      await route.continue()
      return
    }
    const file = join(opts.cacheDir, cacheKey(url))
    let body: Buffer | null = null
    if (existsSync(file)) {
      body = readFileSync(file)
    } else {
      body = fetchViaCurl(url)
      if (body) writeFileSync(file, body)
    }
    if (!body) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const ext = new URL(url).pathname.split('.').pop() ?? ''
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'access-control-allow-origin': '*',
      },
      body,
    })
  })
}
