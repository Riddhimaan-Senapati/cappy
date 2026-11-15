import type { PageInspection } from "../messages.js";
import { scopeLabel } from "../../../shared/validate.js";
import { h } from "./dom.js";

export function renderInspection(root: HTMLElement, snapshot: PageInspection) {
  const section = (title: string, ...children: Node[]) => h("section", "inspect-section", "", [h("h3", "", title), ...children]);
  const detail = (title: string, content: string) => h("details", "inspect-detail", "", [h("summary", "", title), h("pre", "", content)]);
  const { engine, usage } = snapshot;
  const changeCards = snapshot.changes.map(({ change, source }) => h("article", "inspect-change", "", [
    h("h4", "", change.summary),
    h("p", "inspect-source", source),
    h("p", "", change.reason),
    h("p", "inspect-muted", `${change.id} · ${scopeLabel(change.scope).replace(/^./, (letter) => letter.toUpperCase())}`),
    ...(change.css ? [detail("Exact CSS", change.css)] : []),
    ...(change.dom?.length ? [detail("Exact DOM operations and selectors", JSON.stringify(change.dom, null, 2))] : []),
    ...(change.block ? [detail("Built-in capability", JSON.stringify(change.block, null, 2))] : []),
    detail("Full change data", JSON.stringify(change, null, 2)),
  ]));
  root.replaceChildren(
    h("div", "inspect-heading", "", [h("h2", "", "Page inspector"), h("span", "inspect-muted", `Snapshot at ${new Date().toLocaleTimeString()}`)]),
    h("p", "inspect-url", snapshot.url),
    section("How this page is changed",
      h("p", "", "The extension loads dist/content.js on each web page. Its local engine injects CSS, runs defined DOM operations, and applies built-in capabilities. LLM responses describe changes; this engine executes them."),
      h("p", "", "Saved site and global changes are restored locally on page load when adaptations are enabled. Saved request recipes can also run locally. New chat requests, uncached suggestions, automatic page adaptations, and uncached saved commands can call the LLM."),
      h("p", "", engine.observing ? `DOM observer active: ${engine.liveChanges} changes can reapply to newly added elements locally, without another LLM call.` : "DOM observer inactive. Active CSS still applies through the browser’s stylesheet engine."),
    ),
    section("LLM usage on this page",
      h("p", "inspect-count", `${usage.calls.toLocaleString("en-US")} completed calls · ${usage.inputTokens.toLocaleString("en-US")} input / ${usage.outputTokens.toLocaleString("en-US")} output tokens`),
      h("p", "inspect-muted", `Tracked since the content script loaded at ${new Date(snapshot.loadedAt).toLocaleTimeString()}. In-flight or interrupted responses are not counted. Inspect reads local state and does not call the LLM.`),
    ),
    section(`Active changes (${snapshot.changes.length})`, ...(changeCards.length ? changeCards : [h("p", "inspect-muted", "No active adaptations on this page.")])),
    section("Page activity · latest 100 events", ...snapshot.activity.slice().reverse().map(({ at, text }) => h("div", "inspect-event", "", [h("time", "", new Date(at).toLocaleTimeString()), h("span", "", text)]))),
  );
}

export const INSPECTION_CSS = `
.inspect { flex: 1; min-height: 0; overflow: auto; padding: 8px 2px 16px; }
.inspect[hidden], .timeline[hidden], .tools[hidden] { display: none; }
.inspect-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; }
.inspect h2 { margin: 0; font-size: 15px; }
.inspect-url { overflow-wrap: anywhere; color: var(--muted); font-size: 11px; }
.inspect-section { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px; }
.inspect h3 { margin: 0 0 8px; font-size: 12px; color: #b5bdff; }
.inspect p { margin: 7px 0; }
.inspect-muted { color: var(--muted); font-size: 11px; }
.inspect-count { font-variant-numeric: tabular-nums; }
.inspect-change { margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--solid); }
.inspect h4 { margin: 0; font-size: 13px; }
.inspect-source { color: #67d8c3; font-size: 11px; }
.inspect-detail { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 8px; }
.inspect summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.inspect pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.inspect-event { display: grid; grid-template-columns: 78px 1fr; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 11px; }
.inspect time { color: var(--faint); }
.head-actions { display: flex; gap: 6px; }
.head-actions button { padding: 6px 10px; font: inherit; font-size: 12px; }
.head-actions button[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 2px; }
button:focus-visible, .inspect summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.timeline { min-height: 0; }
`;
