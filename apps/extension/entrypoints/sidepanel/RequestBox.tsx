import { useState } from "react";
import { Message } from "../../utils/messages";

export function RequestBox() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const request = text.trim();
    if (!request) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await chrome.runtime.sendMessage(Message.parse({ type: "user-request", text: request }));
      setText("");
      setNote("Request finished. The result is under Last change.");
    } catch {
      setError("That request could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card request">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="request-input">Ask for a change</label>
        <textarea
          id="request-input"
          rows={3}
          maxLength={500}
          placeholder="For example: make the buttons easier to press"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row">
          <button type="submit" disabled={busy || text.trim().length === 0}>
            {busy ? "Working..." : "Send"}
          </button>
        </div>
      </form>
      {note && <p className="muted" aria-live="polite">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
