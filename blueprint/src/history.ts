// A generic bounded undo/redo stack of opaque string snapshots. The
// editor owns serialise/apply; this only owns the stack mechanics.

export class History {
  private past: string[] = []
  private future: string[] = []
  constructor(private cap = 100) {}

  /** Record a pre-mutation snapshot; clears the redo stack. */
  record(snap: string): void {
    this.past.push(snap)
    if (this.past.length > this.cap) this.past.shift()
    this.future = []
  }

  /** Undo last `record`, given the current state to stash for redo;
   *  returns the snapshot to apply, or null when nothing to undo. */
  undo(current: string): string | null {
    if (!this.past.length) return null
    this.future.push(current)
    return this.past.pop()!
  }

  redo(current: string): string | null {
    if (!this.future.length) return null
    this.past.push(current)
    return this.future.pop()!
  }

  /** Drop the most recent `record` (a mutation turned out to be a
   *  no-op, e.g. a duplicate-edge connect). */
  cancel(): void {
    this.past.pop()
  }

  reset(): void {
    this.past = []
    this.future = []
  }
}
