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
  let error = "";
  let pending = false;
  let managing = false;
  const act = async (action: ProfileAction) => {
    if (pending) return;
    pending = true;
    error = "";
    try {
      await updateProfile(action);
      name = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pending = false;
      rerender();
    }
  };
  return (state: StoredState) => {
    const button = (label: string, className: string, action: () => void) => {
      const el = h("button", className, label);
      el.type = "button";
      el.disabled = pending;
      el.addEventListener("click", action);
      return el;
    };
    const picker = profilePicker(state, (id) => void act({ action: "switch", id }));
    picker.classList.add("s-select");
    picker.disabled = pending;
    const manage = button(managing ? "Done" : "Manage", "s-link", () => {
      managing = !managing;
      rerender();
    });
    const rows: Node[] = [h("div", "s-row", "", [h("div", "grow", "", [h("div", "", "Profile"), h("small", "", "Needs, saved changes and commands")]), picker, manage])];
    if (managing) {
      const form = (label: string, value: string, placeholder: string, submitLabel: string, submit: (value: string) => void, onInput?: (value: string) => void) => {
        const input = h("input");
        input.value = value;
        input.placeholder = placeholder;
        input.setAttribute("aria-label", label);
        if (onInput) input.addEventListener("input", () => onInput(input.value));
        const element = h("form", "s-add", "", [input, h("button", "s-btn s-small", submitLabel)]);
        element.addEventListener("submit", (event) => {
          event.preventDefault();
          submit(input.value);
        });
        return element;
      };
      rows.push(
        form("Current profile name", state.profiles[state.activeProfileId].name, "Profile name", "Rename", (value) => void act({ action: "rename", name: value })),
        form("New profile name", name, "New profile, e.g. Mom or Study", "Create", (value) => void act({ action: "create", name: value }), (value) => (name = value)),
        h("div", "s-note", "A new profile starts empty. Tip: type /profile in the bar to switch quickly."),
      );
    }
    if (error) rows.push(h("div", "s-note s-error", error));
    return h("section", "s-sec", "", rows);
  };
}
