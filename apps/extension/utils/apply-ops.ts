import { STYLE_PROPERTIES, type SnapshotOp } from "@browser-agent/shared";

const ALLOWED = new Set<string>(STYLE_PROPERTIES);

// Undo restores the whole style attribute captured before the first op touched the element, so no
// inline value survives undo even when several ops hit the same element.
export function applyOps(ops: readonly SnapshotOp[], map: ReadonlyMap<string, Element>): () => void {
  const originals = new Map<HTMLElement, string | null>();

  const touch = (el: HTMLElement) => {
    if (!originals.has(el)) originals.set(el, el.getAttribute("style"));
  };

  for (const op of ops) {
    for (const id of op.ids) {
      const el = map.get(id);
      if (!(el instanceof HTMLElement)) continue;
      touch(el);
      if (op.op === "hide") {
        el.style.setProperty("display", "none", "important");
        continue;
      }
      for (const [prop, value] of Object.entries(op.styles)) {
        if (!ALLOWED.has(prop) || value === undefined) continue;
        el.style.setProperty(prop, value, "important");
      }
    }
  }

  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    for (const [el, style] of originals) {
      if (style === null) el.removeAttribute("style");
      else el.setAttribute("style", style);
    }
  };
}
