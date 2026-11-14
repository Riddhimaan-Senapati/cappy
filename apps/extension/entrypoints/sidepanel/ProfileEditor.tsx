import { useEffect, useState } from "react";
import { EMPTY_PROFILE, NeedKind, Profile, type Need } from "@browser-agent/shared";
import { KEYS, saveProfile } from "../../utils/state";

export const KIND_LABELS: Record<NeedKind, string> = {
  color_vision: "Color vision",
  light_sensitivity: "Light sensitivity",
  text_size: "Text size",
  motor: "Motor",
  focus: "Focus",
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

function useStoredProfile(): Profile {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const stored = await chrome.storage.local.get(KEYS.profile);
      const parsed = Profile.safeParse(stored[KEYS.profile]);
      if (alive) setProfile(parsed.success ? parsed.data : EMPTY_PROFILE);
    };
    void load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && KEYS.profile in changes) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return profile;
}

export function ProfileEditor() {
  const profile = useStoredProfile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (needs: Need[]) => {
    void saveProfile({ version: profile.version + 1, summary: profile.summary, needs });
  };

  const startEdit = (need: Need) => {
    setEditingId(need.id);
    setDraft(need.detail);
    setError(null);
  };

  const saveEdit = (need: Need) => {
    const detail = draft.trim();
    if (detail.length === 0 || detail.length > 200) {
      setError("Describe the need in 1 to 200 characters.");
      return;
    }
    commit(profile.needs.map((n) => (n.id === need.id ? { ...n, detail } : n)));
    setEditingId(null);
  };

  return (
    <>
      {profile.summary ? <p>{profile.summary}</p> : <p>No profile yet.</p>}
      {profile.needs.length > 0 && (
        <ul className="needs">
          {profile.needs.map((need) => (
            <li key={need.id}>
              {editingId === need.id ? (
                <form
                  className="need-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveEdit(need);
                  }}
                >
                  <label htmlFor={`edit-${need.id}`}>{KIND_LABELS[need.kind]} detail</label>
                  <input
                    id={`edit-${need.id}`}
                    type="text"
                    value={draft}
                    maxLength={200}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="row">
                    <button type="submit">Save</button>
                    <button type="button" className="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <strong>{KIND_LABELS[need.kind]}:</strong> {need.detail}
                  <div className="row">
                    <button type="button" className="secondary" onClick={() => startEdit(need)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => commit(profile.needs.filter((n) => n.id !== need.id))}
                    >
                      Remove
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <button type="button" onClick={() => void saveProfile(DEMO_PROFILE)}>
          Load demo profile
        </button>
        <button type="button" className="secondary" onClick={() => void saveProfile(EMPTY_PROFILE)}>
          Clear profile
        </button>
      </div>
    </>
  );
}
