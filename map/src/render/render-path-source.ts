// ═══ The frame's render path, as ONE text (#2537) ═══
//
// Read by the source-text gates that pin `render()`'s wiring — the ones that
// assert on the SHAPE of the code (a derivation, a clear/restore idiom, an
// exactly-once count) rather than on behaviour a unit test could reach.
//
// Until #2537 every one of them read `vector-tile-renderer.ts`, and that was the
// whole render path. Ten of `render()`'s eleven phases now live in
// `render-phases/`, and #2508 step 3 moved `renderTileKeys()`'s blocks to
// `tile-draw/`, so a gate still reading only the class would stop seeing the
// code it pins — and would go GREEN having stopped, which is the vacuity §12
// keeps paying for. This returns the class plus both directories, restoring
// exactly the scope those assertions were written against; the counting ones
// ("exactly one `this._drapeGlobeFills = false`") in particular are only
// meaningful over the whole path.
//
// Runtime imports nothing here: it is read by tests only, and reads from disk.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Every directory holding a piece of the render path, in the order it is
 *  concatenated. A new one added here is picked up by all 13 gates at once —
 *  which is the point of there being ONE reader. */
const PATH_DIRS = ['render-phases', 'tile-draw'] as const

/** The lifted modules take the renderer as a parameter named `vtr`, where the
 *  class body said `this`. The RECEIVER's spelling changed; what these gates
 *  assert — that the renderer's own field is read, written or cleared at a given
 *  site — did not. Normalising it here keeps every existing anchor literal valid
 *  and confined the #2537 churn to one place instead of eight test files.
 *
 *  Scoped to the lifted modules, and `vtr` is only ever their first parameter,
 *  so this cannot rewrite an unrelated identifier. */
const asReceiver = (phaseSrc: string): string => phaseSrc.replace(/\bvtr\./g, 'this.')

/** `vector-tile-renderer.ts` followed by every lifted module, directory order
 *  then name-sorted, so the concatenation is stable and a gate's index
 *  arithmetic is reproducible. */
export function renderPathSource(): string {
  const parts = [readFileSync(join(HERE, 'vector-tile-renderer.ts'), 'utf8')]
  for (const dir of PATH_DIRS) {
    const abs = join(HERE, dir)
    for (const f of readdirSync(abs)
      .filter((x) => x.endsWith('.ts'))
      .sort()) {
      parts.push(asReceiver(readFileSync(join(abs, f), 'utf8')))
    }
  }
  return parts.join('\n')
}
