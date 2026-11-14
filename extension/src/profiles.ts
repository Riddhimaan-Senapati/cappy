import { DEFAULTS, PROFILE_KEYS, load, save, type ProfileState, type StoredState } from "./storage.js";

export function profileState(state: StoredState): ProfileState {
  return structuredClone(Object.fromEntries(PROFILE_KEYS.map((key) => [key, state[key]]))) as ProfileState;
}

export type ProfileAction =
  | { action: "switch"; id: string }
  | { action: "create"; name: string }
  | { action: "delete"; id: string }
  | { action: "rename"; name: string };

// Active data stays in the existing storage fields; inactive profiles keep a snapshot.
export function profilePatch(state: StoredState, action: ProfileAction): Partial<StoredState> {
  const profiles = { ...state.profiles };
  if (action.action === "delete") {
    if (!profiles[action.id]) throw new Error("Profile not found.");
    if (Object.keys(profiles).length === 1) throw new Error("Keep at least one profile.");
    delete profiles[action.id];
    if (action.id !== state.activeProfileId) return { profiles };
    const id = profiles.default ? "default" : Object.keys(profiles)[0];
    const next = profiles[id].state!;
    profiles[id] = { name: profiles[id].name };
    return { ...next, activeProfileId: id, profiles };
  }
  if (action.action === "rename") {
    const name = action.name.trim();
    if (!name) throw new Error("Enter a profile name.");
    profiles[state.activeProfileId] = { ...profiles[state.activeProfileId], name };
    return { profiles };
  }
  if (action.action === "switch" && action.id === state.activeProfileId) return {};
  profiles[state.activeProfileId] = { name: profiles[state.activeProfileId].name, state: profileState(state) };
  let id: string;
  let next: ProfileState;
  if (action.action === "create") {
    const name = action.name.trim();
    if (!name) throw new Error("Enter a profile name.");
    id = crypto.randomUUID();
    next = profileState(DEFAULTS);
    profiles[id] = { name };
  } else {
    id = action.id;
    if (!profiles[id]?.state) throw new Error("Profile not found.");
    next = profiles[id].state!;
    profiles[id] = { name: profiles[id].name };
  }
  return { ...next, activeProfileId: id, profiles };
}

export async function updateProfile(action: ProfileAction) {
  const response = await chrome.runtime.sendMessage({ kind: "profileAction", ...action });
  if (!response?.ok) throw new Error(response?.error ?? "Could not update the profile.");
}

export async function applyProfileAction(action: ProfileAction) {
  await save(profilePatch(await load(), action));
}
