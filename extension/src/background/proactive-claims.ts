// One page-load check per site. A running check keeps its claim until that run finishes,
// even if the tab has moved on. A chat error in the tab must not clear it.
export class ProactiveClaims {
  private pending = new Map<number, { key: string; runId?: string }>();
  private inFlight = new Set<string>();
  private runs = new Map<string, string>();

  holds(key: string): boolean {
    return this.inFlight.has(key);
  }

  // Returns false when another check of this site is already running.
  begin(tabId: number, key: string): boolean {
    const previous = this.pending.get(tabId);
    if (previous && previous.key !== key) {
      // A check that never started can be dropped. One with a run id stays until that run ends.
      if (!previous.runId) this.inFlight.delete(previous.key);
      this.pending.delete(tabId);
    }
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    this.pending.set(tabId, { key });
    return true;
  }

  // The key comes from the run that started, not from whichever site the tab shows now.
  noteStart(tabId: number, runId: string, key?: string) {
    if (key) {
      this.inFlight.add(key);
      this.runs.set(runId, key);
      const pending = this.pending.get(tabId);
      if (pending?.key === key && pending.runId === undefined) pending.runId = runId;
      return;
    }
    const pending = this.pending.get(tabId);
    if (!pending || pending.runId !== undefined) return;
    pending.runId = runId;
    this.runs.set(runId, pending.key);
  }

  // The key to mark or drop, only when this event is the page-load run that claimed it.
  finish(_tabId: number, runId: string): string | null {
    const key = this.runs.get(runId);
    if (!key) return null;
    this.runs.delete(runId);
    for (const [tabId, pending] of this.pending) {
      if (pending.runId === runId) this.pending.delete(tabId);
    }
    return key;
  }

  release(tabId: number, key: string) {
    const pending = this.pending.get(tabId);
    if (pending?.key === key) {
      if (pending.runId) this.runs.delete(pending.runId);
      this.pending.delete(tabId);
    }
    this.inFlight.delete(key);
  }

  drop(key: string) {
    this.inFlight.delete(key);
  }
}
