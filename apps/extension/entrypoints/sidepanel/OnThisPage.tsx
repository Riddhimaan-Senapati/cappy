import { Message } from "../../utils/messages";
import { KEYS, type LastResult } from "../../utils/state";
import { SavedChanges } from "./SavedChanges";
import { parseLast, useStored } from "./hooks";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function blocksLabel(blocks: string[]): string {
  if (blocks.length === 0) return "Page styles";
  const text = blocks.map((block) => block.replace(/_/g, " ")).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function OnThisPage() {
  const last = useStored("session", KEYS.last, parseLast);
  return (
    <section className="card" aria-labelledby="h-on-this-page">
      <h2 id="h-on-this-page">On this page</h2>
      <LastChange last={last} />
      <details className="saved">
        <summary>Saved changes</summary>
        <SavedChanges />
      </details>
    </section>
  );
}

function LastChange({ last }: { last: LastResult | undefined }) {
  if (!last) return <p className="empty">Nothing has been adapted yet. Visit a site once a profile is loaded.</p>;

  switch (last.status) {
    case "applied":
      return (
        <article className="change">
          <div className="change-head">
            <strong>{blocksLabel(last.blocks)}</strong>
            <span className="scope">{hostOf(last.url)}</span>
            <button
              type="button"
              className="link"
              onClick={() => void chrome.runtime.sendMessage(Message.parse({ type: "undo", adaptationId: last.adaptationId }))}
            >
              Undo
            </button>
          </div>
          <p className="reason">{last.reason}</p>
          {last.restored && <p className="muted">Restored from a saved change.</p>}
        </article>
      );
    case "undone":
      return <p className="reason">Change undone on {hostOf(last.url)}.</p>;
    case "none":
      return <p className="reason">No change for {hostOf(last.url)}: {last.reason}</p>;
    case "blocked":
      return <p className="reason">Blocked for {hostOf(last.url)}: {last.reason}</p>;
    case "error":
      return <p role="alert" className="error">Could not adapt {hostOf(last.url)}: {last.message}</p>;
  }
}
