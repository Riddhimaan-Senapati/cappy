import { updateProfile, type ProfileAction } from "../profiles.js";
import type { StoredState } from "../storage.js";
import { h } from "./dom.js";

export function profilePicker(state: StoredState, onChange: (id: string) => void) {
  const select = h("select", "profile-picker");
  select.setAttribute("aria-label", "Active profile");
  select.title = "Switch profile across all websites";
  for (const [id, profile] of Object.entries(state.profiles)) {
    const option = h("option", "", profile.name);
    option.value = id;
    select.append(option);
  }
  select.value = state.activeProfileId;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function createProfilesView(rerender: () => void) {
  let name = "";
  let renameDraft: string | null = null;
  let error = "";
  let pending = false;
  const act = async (action: ProfileAction) => {
    if (pending) return;
    pending = true;
    error = "";
    try {
      await updateProfile(action);
      name = "";
      renameDraft = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pending = false;
      rerender();
    }
  };
  return (state: StoredState) => {
    const button = (label: string, action: () => void) => {
      const el = h("button", "s-btn s-small", label);
      el.type = "button";
      el.disabled = pending;
      el.addEventListener("click", action);
      return el;
    };
    const picker = profilePicker(state, (id) => void act({ action: "switch", id }));
    picker.classList.add("s-select");
    picker.disabled = pending;
    const rename = h("input");
    const storedName = state.profiles[state.activeProfileId]?.name ?? "";
    rename.value = renameDraft ?? storedName;
    rename.setAttribute("aria-label", "Current profile name");
    rename.addEventListener("input", () => { renameDraft = rename.value; });
    const renameForm = h("form", "s-add", "", [rename, button("Rename", () => void act({ action: "rename", name: rename.value }))]);
    renameForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void act({ action: "rename", name: rename.value });
    });
    const input = h("input");
    input.placeholder = "New profile name";
    input.setAttribute("aria-label", "New profile name");
    input.value = name;
    input.addEventListener("input", () => { name = input.value; });
    return h("section", "s-sec", "", [
      h("h3", "", "Profiles"),
      h("div", "s-row", "", [h("div", "grow", "", [h("div", "", "Active on all websites"), h("small", "", "Each profile saves its own preferences, layouts, filters, commands, and request history. Changes are saved automatically.")]), picker]),
      renameForm,
      h("div", "s-note", "Type /profile in the command bar to create or switch profiles. New profiles start without saved directives or layouts."),
      h("div", "s-add", "", [input]),
      h("div", "s-acts", "", [
        button("New profile", () => void act({ action: "create", name })),
      ]),
      h("div", "s-note", "Switching updates open websites and future pages. Saved layouts restore locally; adapting a new website needs the AI connection."),
      ...(error ? [h("div", "s-note s-error", error)] : []),
    ]);
  };
}
