import { useState } from "react";
import { EMPTY_PROFILE, Need, NeedId, NeedKind, Profile } from "@browser-agent/shared";
import { KEYS, saveProfile } from "../../utils/state";
import { PREFERENCE_KEY, parseStore, type PreferenceEntry, type PreferenceStore } from "../../utils/preferences";
import { guessNeedKind } from "../../utils/ui-need";
import { parseFlag, useStored } from "./hooks";

export const KIND_LABELS: Record<NeedKind, string> = {
  color_vision: "Color vision",
  light_sensitivity: "Light sensitivity",
  text_size: "Text size",
  motor: "Motor",
  focus: "Focus",
  preference: "Preference",
};

const DEMO_PROFILE = Profile.parse({
  version: 1,
  summary:
    "Maya is a student who is red-green colorblind, sensitive to flashing content, and prefers larger text.",
  needs: [
    { id: "n1", kind: "color_vision", detail: "red-green colorblind (deuteranopia)", source: "onboarding" },
    { id: "n2", kind: "light_sensitivity", detail: "flashing content gives headaches", source: "onboarding" },
    { id: "n3", kind: "text_size", detail: "prefers larger text", source: "onboarding" },
  ],
});

const MAX_NEEDS = 20;
const MAX_DETAIL = 200;

const parseProfile = (raw: unknown): Profile | undefined => {
  const parsed = Profile.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

// Says what a saved preference does on pages; an entry for an older wording of the detail counts as still setting up.
function preferenceStatus(entry: PreferenceEntry | undefined, detail: string): string {
  if (!entry || entry.detail !== detail) return "Setting up…";
  switch (entry.status) {
    case "compiled":
      return `Applies everywhere: ${entry.summary ?? "saved"}`;
    case "none":
      return `Guides the agent only: ${entry.reason ?? "no page change fits"}`;
    case "error":
      return "Couldn't reach the server, will retry";
    case "pending":
      return "Setting up…";
  }
}

export function ProfileEditor() {
  const profile = useStored("local", KEYS.profile, parseProfile) ?? EMPTY_PROFILE;
  const changes: PreferenceStore = useStored("local", PREFERENCE_KEY, parseStore) ?? {};

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newNeed, setNewNeed] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (needs: Need[]) => saveProfile({ version: profile.version + 1, summary: profile.summary, needs });

  const add = () => {
    const detail = newNeed.trim();
    if (!detail) return;
    if (detail.length > MAX_DETAIL) return setError(`Keep a need under ${MAX_DETAIL} characters.`);
    if (profile.needs.length >= MAX_NEEDS) return setError(`A profile holds up to ${MAX_NEEDS} needs. Remove one first.`);
    const need: Need = {
      id: NeedId.parse(crypto.randomUUID()),
      kind: guessNeedKind(detail),
      detail,
      source: "onboarding",
    };
    setError(null);
    setNewNeed("");
    void commit([...profile.needs, need]);
  };

  const saveEdit = (need: Need) => {
    const detail = draft.trim();
    if (detail.length === 0 || detail.length > MAX_DETAIL) {
      setError(`Describe the need in 1 to ${MAX_DETAIL} characters.`);
      return;
    }
    setError(null);
    setEditingId(null);
    void commit(profile.needs.map((n) => (n.id === need.id ? { ...n, detail } : n)));
  };

  return (
    <section className="card" aria-labelledby="h-profile">
      <div className="card-head">
        <h2 id="h-profile">Your profile</h2>
        <StoredToggle storageKey="proactive" fallback={true} label="Act on page load" />
        <StoredToggle storageKey="askBeforeRemember" fallback={false} label="Ask before remembering" />
      </div>

      {profile.needs.length > 0 ? (
        <ul className="chips" aria-label="Your needs">
          {profile.needs.map((need) => {
            const label = KIND_LABELS[need.kind];
            if (editingId === need.id) {
              return (
                <li key={need.id} className="chip editing">
                  <form
                    className="need-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveEdit(need);
                    }}
                  >
                    <label htmlFor={`edit-${need.id}`}>{label} detail</label>
                    <input id={`edit-${need.id}`} type="text" value={draft} maxLength={MAX_DETAIL} onChange={(e) => setDraft(e.target.value)} />
                    <div className="row">
                      <button type="submit" className="small">Save</button>
                      <button type="button" className="small ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </li>
              );
            }
            return (
              <li key={need.id} className="chip">
                <span className="chip-text">
                  <span className="chip-kind">{label}</span> {need.detail}
                  {need.kind === "preference" && (
                    <span className="chip-status">{preferenceStatus(changes[need.id], need.detail)}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="icon edit"
                  aria-label={`Edit ${label} need: ${need.detail}`}
                  onClick={() => {
                    setEditingId(need.id);
                    setDraft(need.detail);
                    setError(null);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${label} need: ${need.detail}`}
                  onClick={() => void commit(profile.needs.filter((n) => n.id !== need.id))}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty">No needs yet. Tell me in the chat, or add one below.</p>
      )}

      {error && <p role="alert" className="error">{error}</p>}

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          aria-label="Add a need"
          placeholder="Add a need or preference, e.g. prefers dark mode"
          value={newNeed}
          maxLength={MAX_DETAIL}
          onChange={(event) => setNewNeed(event.target.value)}
        />
        <button type="submit" disabled={newNeed.trim().length === 0}>
          Add
        </button>
      </form>

      <div className="row-links">
        <button type="button" className="link" onClick={() => void saveProfile(DEMO_PROFILE)}>
          Load demo profile
        </button>
        <button type="button" className="link" onClick={() => void saveProfile(EMPTY_PROFILE)}>
          Clear
        </button>
      </div>
    </section>
  );
}

// Updates on click and writes through to storage, so the checkbox never lags behind the storage round trip.
function StoredToggle({ storageKey, fallback, label }: { storageKey: string; fallback: boolean; label: string }) {
  const stored = useStored("local", storageKey, parseFlag);
  const [checked, setChecked] = useState<boolean | undefined>(undefined);
  const value = checked ?? stored ?? fallback;
  return (
    <label className="mini">
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setChecked(next);
          void chrome.storage.local.set({ [storageKey]: next });
        }}
      />
      {label}
    </label>
  );
}
