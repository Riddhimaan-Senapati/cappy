// Snapshots attributes before mutating them so undo restores the exact original
// attribute order too; outerHTML comparisons depend on that.
export class Journal {
  private readonly undos: Array<() => void> = [];

  touch(el: Element): void {
    const snapshot = Array.from(el.attributes, (attr) => [attr.name, attr.value] as const);
    this.undos.push(() => {
      for (const name of el.getAttributeNames()) el.removeAttribute(name);
      for (const [name, value] of snapshot) el.setAttribute(name, value);
    });
  }

  add(undo: () => void): void {
    this.undos.push(undo);
  }

  unwind(): void {
    for (let undo = this.undos.pop(); undo; undo = this.undos.pop()) {
      try {
        undo();
      } catch (err) {
        console.warn("runtime block undo step failed", err);
      }
    }
  }
}
