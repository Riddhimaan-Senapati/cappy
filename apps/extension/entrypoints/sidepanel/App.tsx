import { useEffect, useRef, useState } from "react";
import { createCompanion, type Companion, type CompanionView } from "@browser-agent/companion";
import { Message } from "../../utils/messages";
import { callLlm } from "../../utils/backend";
import { getInstallId, saveProfile } from "../../utils/state";
import { ChatLog, type Entry } from "./ChatLog";
import { Composer } from "./Composer";
import { GesturePanel } from "./GesturePanel";
import { Header } from "./Header";
import { OnThisPage } from "./OnThisPage";
import { ProfileEditor } from "./ProfileEditor";
import { RulesCard } from "./RulesCard";

export function App() {
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [view, setView] = useState<CompanionView | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  // Companion messages seen so far; anything beyond this count is new and must be shown once.
  const knownCount = useRef(0);

  const addEntry = (role: Entry["role"], text: string) =>
    setEntries((prev) => [...prev, { id: crypto.randomUUID(), role, text, at: Date.now() }]);

  const absorb = (next: CompanionView) => {
    const fresh = next.messages.slice(knownCount.current);
    knownCount.current = next.messages.length;
    const at = Date.now();
    // The user's own line was already shown when it was sent, so only replies are added here.
    const replies: Entry[] = fresh
      .filter((message) => message.role === "assistant")
      .map((message) => ({ id: crypto.randomUUID(), role: "agent", text: message.content, at }));
    if (replies.length > 0) setEntries((prev) => [...prev, ...replies]);
    setView(next);
  };

  useEffect(() => {
    let alive = true;
    const start = async () => {
      try {
        const created = await createCompanion({ llm: callLlm, threadId: await getInstallId() });
        const first = await created.view();
        if (!alive) return;
        const history: Entry[] = first.messages.map((message) => ({
          id: crypto.randomUUID(),
          role: message.role === "user" ? "user" : "agent",
          text: message.content,
          at: 0,
        }));
        knownCount.current = first.messages.length;
        setEntries((prev) => [...history, ...prev]);
        setView(first);
        setCompanion(created);
      } catch {
        if (alive) addEntry("system", "The companion is not available yet. Page changes still work.");
      }
    };
    void start();
    return () => {
      alive = false;
    };
    // The companion is created once per panel; addEntry only uses the stable state setter.
  }, []);

  const sendPageChange = async (text: string) => {
    try {
      await chrome.runtime.sendMessage(Message.parse({ type: "user-request", text }));
    } catch {
      addEntry("system", "That page change could not be sent. Try again.");
    }
  };

  const askCompanion = async (text: string) => {
    if (!companion) {
      addEntry("system", "The companion is still starting. Try again in a moment.");
      return;
    }
    setBusy(true);
    try {
      const view = await companion.send(text);
      absorb(view);
      const { askBeforeRemember } = await chrome.storage.local.get("askBeforeRemember");
      if (view.pending && askBeforeRemember !== true) {
        const next = await companion.decide(true);
        absorb(next);
        await saveProfile(next.profile);
        addEntry("system", `Remembered: ${view.pending.need.detail}. Remove it from Your profile if that is wrong.`);
      }
    } catch {
      addEntry("system", "The companion did not answer. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const sendText = (text: string) => {
    addEntry("user", text);
    void sendPageChange(text);
    void askCompanion(text);
  };

  const decide = async (accept: boolean) => {
    if (!companion) return;
    setBusy(true);
    try {
      const next = await companion.decide(accept);
      absorb(next);
      if (accept) await saveProfile(next.profile);
    } catch {
      addEntry("system", "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <Header />
      <div className="top-cards">
        <ProfileEditor />
        <OnThisPage />
        <RulesCard />
        <GesturePanel />
      </div>
      <ChatLog entries={entries} proposal={view?.pending ?? null} busy={busy} onDecide={(accept) => void decide(accept)} />
      <Composer onSend={sendText} />
    </div>
  );
}
