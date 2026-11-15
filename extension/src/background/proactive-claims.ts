// One page-load check per site. A tab that leaves mid-check must drop the site it left,
// and a chat error in that tab must not drop the check that is still running.
export class ProactiveClaims {
  private pending = new Map<number, { key: string; runId?: string }>();
  private inFlight = new Set<string>();

  holds(key: string): boolean {
    return this.inFlight.has(key);
  }

  // Returns false when another check of this site is already running.
  begin(tabId: number, key: string): boolean {
    const previous = this.pending.get(tabId);
    if (previous && previous.key !== key) {
      this.inFlight.delete(previous.key);
      this.pending.delete(tabId);
    }
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    this.pending.set(tabId, { key });
    return true;
  }

  noteStart(tabId: number, runId: string) {
    const pending = this.pending.get(tabId);
    if (pending && pending.runId === undefined) pending.runId = runId;
  }

  // The key to mark or drop, only when this event is the page-load run that claimed it.
  finish(tabId: number, runId: string): string | null {
    const pending = this.pending.get(tabId);
    if (!pending || pending.runId !== runId) return null;
    this.pending.delete(tabId);
    return pending.key;
  }

  release(tabId: number, key: string) {
    if (this.pending.get(tabId)?.key === key) this.pending.delete(tabId);
    this.inFlight.delete(key);
  }

  drop(key: string) {
    this.inFlight.delete(key);
  }
}
