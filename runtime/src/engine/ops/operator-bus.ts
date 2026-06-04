import type { DirtyTracker } from '../state/dirty'
import type { Op } from './op-types'

/** Records each mutation Op and tags the dirty domains it touched. At S4 this
 *  is the single recording funnel for the routed setters; consumers (undo,
 *  granular skip) read it at S14+. Bounded log so a 60Hz op stream cannot grow
 *  without bound. */
export class OperatorBus {
  private readonly log: Op[] = []
  private static readonly MAX_LOG = 256
  constructor(private readonly dirty: DirtyTracker) {}
  /** Apply an op's invalidation: record it (bounded) and tag its domains. The
   *  setter performs the actual field mutation itself (dispatch-alongside). */
  dispatch(op: Op, domains: number): void {
    this.log.push(op)
    if (this.log.length > OperatorBus.MAX_LOG) this.log.shift()
    this.dirty.tag(domains)
  }
  /** Most-recent op (for tests / future undo). */
  lastOp(): Op | undefined {
    return this.log[this.log.length - 1]
  }
  /** Current bounded log depth (for tests). */
  get depth(): number {
    return this.log.length
  }
}
