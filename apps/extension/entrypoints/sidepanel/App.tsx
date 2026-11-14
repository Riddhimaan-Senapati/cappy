import { useEffect, useState, type ReactNode } from "react";
import { createCompanion, type Companion, type CompanionView } from "@browser-agent/companion";
import { Message } from "../../utils/messages";
import { ProfileEditor, KIND_LABELS } from "./ProfileEditor";
import { RequestBox } from "./RequestBox";
import { callLlm } from "../../utils/backend";
import { GesturePanel } from "./GesturePanel";
import { VerifyPanel } from "./VerifyPanel";
import { StepsTimeline } from "./StepsTimeline";
import { SavedChanges } from "./SavedChanges";
import {
  KEYS,
  LastResult,
  getInstallId,
  readParsed,
  saveProfile,
} from "../../utils/state";

function useStored<T>(
  area: "local" | "session",
  key: string,
  parse: (raw: unknown) => T | undefined,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const stored = await chrome.storage[area].get(key);
      const next = parse(stored[key]);
      if (alive) setValue(next);
    };
    void load();
    const onChanged = (changes: Record<string, unknown>, changedArea: string) => {
      if (changedArea === area && key in changes) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [area, key, parse]);
  return value;
}

const parseLast = (raw: unknown) => {
  const parsed = LastResult.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

export function App() {
  const last = useStored("session", KEYS.last, parseLast);

  return (
    <main className="panel">
      <h1>Adaptive Browser Agent</h1>

      <Section title="Your profile">
        <ProfileEditor />
      </Section>

      <RequestBox />

      <Section title="Last change">
        <LastChange last={last} />
      </Section>

      <StepsTimeline />

      <VerifyPanel />

      <Section title="Companion">
        <CompanionPanel />
      </Section>

      <GesturePanel />

      <Section title="Saved changes">
        <SavedChanges />
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={`h-${title.replace(/\W+/g, "-")}`}>
      <h2 id={`h-${title.replace(/\W+/g, "-")}`}>{title}</h2>
      {children}
    </section>
  );
}

function LastChange({ last }: { last: LastResult | undefined }) {
  if (!last) return <p>Nothing has been adapted yet. Visit a site once a profile is loaded.</p>;

  switch (last.status) {
    case "applied":
      return (
        <>
          <p>
            <strong>Why:</strong> {last.reason}
          </p>
          <p>
            <strong>Changes:</strong> {last.blocks.length > 0 ? last.blocks.join(", ") : "page styles"}
          </p>
          <p className="muted">{last.url}</p>
          {last.restored && <p className="muted">Restored from a saved change.</p>}
          <button
            type="button"
            onClick={() => {
              const msg = Message.parse({ type: "undo", adaptationId: last.adaptationId });
              void chrome.runtime.sendMessage(msg);
            }}
          >
            Undo this change
          </button>
        </>
      );
    case "undone":
      return <p>Change undone on {last.url}.</p>;
    case "none":
      return <p>No change for {last.url}: {last.reason}</p>;
    case "blocked":
      return <p>Blocked for {last.url}: {last.reason}</p>;
    case "error":
      return <p role="alert">Could not adapt {last.url}: {last.message}</p>;
  }
}

function CompanionPanel() {
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [view, setView] = useState<CompanionView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const start = async () => {
      try {
        const threadId = await getInstallId();
        const created = await createCompanion({ llm: callLlm, threadId });
        const first = await created.view();
        if (!alive) return;
        setCompanion(created);
        setView(first);
      } catch {
        if (alive) setUnavailable(true);
      }
    };
    void start();
    return () => {
      alive = false;
    };
  }, []);

  if (unavailable || !companion) {
    return <p>{unavailable ? "Companion not available yet." : "Starting companion..."}</p>;
  }

  const run = async (action: () => Promise<CompanionView>) => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch {
      setError("That did not work. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const next = await run(() => companion.send(text));
    if (next) {
      setView(next);
      setDraft("");
    }
  };

  const decide = async (accept: boolean) => {
    const next = await run(() => companion.decide(accept));
    if (!next) return;
    setView(next);
    if (accept) await saveProfile(next.profile);
  };

  return (
    <div className="companion">
      <ol className="chat" aria-live="polite" aria-label="Conversation">
        {(view?.messages ?? []).map((m, i) => (
          <li key={i} className={m.role === "user" ? "from-user" : "from-agent"}>
            <span className="who">{m.role === "user" ? "You" : "Agent"}</span> {m.content}
          </li>
        ))}
      </ol>

      {view?.pending && (
        <div className="proposal" role="group" aria-label="Proposed change">
          <p>
            <strong>Proposed:</strong> add {KIND_LABELS[view.pending.need.kind].toLowerCase()} need,{" "}
            {view.pending.need.detail}.
          </p>
          <p className="muted">{view.pending.why}</p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void decide(true)}>
              Accept
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void decide(false)}>
              Reject
            </button>
          </div>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="companion-input">Message the agent</label>
        <textarea
          id="companion-input"
          rows={3}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={busy || draft.trim().length === 0}>
          Send
        </button>
      </form>

      {error && <p role="alert">{error}</p>}
    </div>
  );
}
