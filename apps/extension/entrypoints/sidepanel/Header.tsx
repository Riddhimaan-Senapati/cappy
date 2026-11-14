import { Message } from "../../utils/messages";
import { KEYS, LastResult } from "../../utils/state";
import { parseFlag, useServerHealth, useStored } from "./hooks";

const STATUS_TEXT = {
  checking: "Checking server…",
  online: "Server online",
  offline: "Server offline",
} as const;

// The kill switch only writes the flag; the background decides what to do with it for new pages.
async function setPaused(paused: boolean) {
  await chrome.storage.local.set({ paused });
  if (!paused) return;
  const stored = await chrome.storage.session.get(KEYS.last);
  const last = LastResult.safeParse(stored[KEYS.last]);
  if (last.success && last.data.status === "applied") {
    const undo = Message.parse({ type: "undo", adaptationId: last.data.adaptationId });
    await chrome.runtime.sendMessage(undo).catch(() => undefined);
  }
}

export function Header() {
  const health = useServerHealth();
  const paused = useStored("local", "paused", parseFlag) ?? false;
  const on = !paused;

  return (
    <header className="top">
      <div>
        <h1>Adaptive Agent</h1>
        <p className="status" data-state={health} role="status">
          {STATUS_TEXT[health]}
        </p>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label="Adaptations"
          checked={on}
          onChange={(event) => void setPaused(!event.currentTarget.checked)}
        />
        <span>{on ? "On" : "Off"}</span>
      </label>
    </header>
  );
}
