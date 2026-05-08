// Build-time git metadata. Astro frontmatter runs Node, so we can
// shell out to `git log` and embed the result in the page.
//
// Path argument is relative to the REPO ROOT (e.g.
// `site/src/pages/docs/sources.astro`). The helper resolves the
// repo root via `git rev-parse --show-toplevel` once, then runs
// every git query with that as `cwd`. Without the explicit cwd the
// astro build process runs from `site/` and the file paths resolve
// to a nonexistent location, so every page silently shows no stamp.

import { execSync } from 'node:child_process'

interface Meta {
  /** ISO 8601 commit timestamp of the most recent change to the file. */
  iso: string | null
  /** Human-friendly relative form, e.g. "3 days ago". */
  relative: string | null
  /** Distinct contributor count (by author email). */
  contributors: number
}

const cache = new Map<string, Meta>()

let _repoRoot: string | null | undefined
function repoRoot(): string | null {
  if (_repoRoot !== undefined) return _repoRoot
  try {
    _repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    _repoRoot = null
  }
  return _repoRoot
}

export function gitMeta(filePath: string): Meta {
  const hit = cache.get(filePath)
  if (hit) return hit

  const empty: Meta = { iso: null, relative: null, contributors: 0 }
  const cwd = repoRoot()
  if (!cwd) {
    cache.set(filePath, empty)
    return empty
  }

  let result = empty
  try {
    // -1 = newest commit, format=%aI gives strict ISO 8601.
    const iso = execSync(
      `git log -1 --format=%aI -- "${filePath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd },
    ).trim()
    if (!iso) {
      cache.set(filePath, empty)
      return empty
    }
    const authors = execSync(
      `git log --format=%ae -- "${filePath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd },
    )
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
    const distinct = new Set(authors).size

    result = {
      iso,
      relative: relativeTime(iso),
      contributors: distinct,
    }
  } catch {
    // Not in a git repo (e.g. fresh clone with no .git, or a sandbox
    // without the binary). Fall back to empty so the layout just
    // hides the stamp.
  }
  cache.set(filePath, result)
  return result
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const diffMs = Date.now() - ts
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`
  const year = Math.floor(day / 365)
  return `${year} year${year === 1 ? '' : 's'} ago`
}
