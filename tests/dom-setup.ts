import { Window } from "happy-dom";

// Registers a happy-dom window as globals once. Skipped when a real DOM is already present.
export function installDom(): Window {
  const win = new Window({ url: "https://www.youtube.com/" });
  if (globalThis.document === undefined) {
    const globals: Record<string, unknown> = {
      window: win,
      document: win.document,
      location: win.location,
      Node: win.Node,
      Element: win.Element,
      HTMLElement: win.HTMLElement,
      MutationObserver: win.MutationObserver,
      NodeFilter: win.NodeFilter,
      getComputedStyle: win.getComputedStyle.bind(win),
    };
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  }
  return globalThis.window as unknown as Window;
}
