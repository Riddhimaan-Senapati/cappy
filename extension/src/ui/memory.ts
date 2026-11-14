import { addLine, clearAllMemory, editLine, forgetLine, pendingSite } from "../memory.js";
import { activityOverview, clearActivity } from "../friction-log.js";
import { forgetSiteNotes, type StoredState } from "../storage.js";
import { h } from "./dom.js";
import { scopeChoices } from "./memory-choice.js";

export type ToggleRow = (label: string, sub: string, checked: boolean, onChange: (value: boolean) => void) => Node;

export interface MemoryView {
  render(state: StoredState, toggleRow: ToggleRow): HTMLElement;
}

export function createMemoryView(rerender: () => void): MemoryView {
  let draft = "";
  let editing: number | null = null;
  let editDraft = "";
  let confirmingClear = false;
  let editInput: HTMLInputElement | null = null;

  const button = (label: string, className: string, onClick: () => void) => {
    const el = h("button", className, label);
    el.type = "button";
    el.addEventListener("click", onClick);
    return el;
  };

  const savedRow = (line: string, index: number) => {
    if (editing === index) {
      const input = h("input");
      input.value = editDraft;
      input.setAttribute("aria-label", "Edit memory line");
      input.addEventListener("input", () => (editDraft = input.value));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          editing = null;
          rerender();
        }
      });
      editInput = input;
      const save = h("button", "s-link", "Save");
      save.type = "submit";
      const cancel = button("Cancel", "s-link", () => {
        editing = null;
        rerender();
      });
      const form = h("form", "s-add", "", [input, save, cancel]);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = editDraft;
        editing = null;
        await editLine(index, value);
        rerender();
      });
      return form;
    }
    return h("div", "s-row", "", [
      h("div", "grow", line),
      button("Edit", "s-link", () => {
        editing = index;
        editDraft = line;
        rerender();
      }),
      button("Forget this", "s-link", () => void forgetLine(line)),
    ]);
  };

  const proposalRow = (state: StoredState, line: string) => {
    const origin = pendingSite(state, line);
    return h("div", "s-row", "", [
      h("div", "grow", "", [h("div", "", line), ...(origin ? [h("small", "", `From ${origin.host}`)] : [])]),
      ...scopeChoices([line], origin?.host, origin?.scope).map((choice) => button(choice.label, "s-link", () => void choice.run())),
    ]);
  };

  const activityRow = (state: StoredState) => {
    const { events, sites } = activityOverview(state.activity ?? { buckets: {}, totals: {} }, Date.now());
    const summary = events ? `${events} event${events === 1 ? "" : "s"} across ${sites} site${sites === 1 ? "" : "s"} in the last 6 hours` : "Nothing noticed in the last 6 hours";
    return h("div", "s-row", "", [
      h("div", "grow", "", [h("div", "", "Activity"), h("small", "", `${summary}. Counts only, used to suggest help and give the agent context.`)]),
      button("Clear", "s-link", () => void clearActivity()),
    ]);
  };

  const siteSkillRows = (state: StoredState): Node[] => {
    const hosts = Object.entries(state.siteSkills).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    if (!hosts.length) return [];
    return [
      h("div", "s-note", "Site skills: notes the agent saved about how these websites are built, so later requests there go faster. They hold nothing about you."),
      ...hosts.map(([host, skill]) =>
        h("div", "s-row", "", [
          h("div", "grow", "", [h("div", "", host), h("small", "", `${skill.notes.length} note${skill.notes.length === 1 ? "" : "s"}: ${skill.notes.slice(-2).join(" · ")}`)]),
          button("Forget", "s-link", () => void forgetSiteNotes(host)),
        ]),
      ),
    ];
  };

  return {
    render(state, _toggleRow) {
      editInput = null;
      const addForm = h("form", "s-add");
      const input = h("input");
      input.placeholder = "Add a need or preference, e.g. no autoplay videos";
      input.value = draft;
      input.setAttribute("aria-label", "Add a memory line");
      input.addEventListener("input", () => (draft = input.value));
      addForm.append(input, h("button", "s-btn", "Add"));
      addForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const line = input.value.trim();
        if (!line) return;
        draft = "";
        await addLine(line);
      });

      const clearButton = confirmingClear
        ? h("div", "s-row", "", [
            h("div", "grow", `Clear ${state.profile.length} saved line(s) and ${state.pendingMemory.length} proposal(s)? This cannot be undone.`),
            button("Cancel", "s-link", () => {
              confirmingClear = false;
              rerender();
            }),
            button("Confirm clear", "s-link", async () => {
              confirmingClear = false;
              await clearAllMemory();
            }),
          ])
        : h("div", "s-foot", "", [
            button("Clear all", "s-btn", () => {
              confirmingClear = true;
              rerender();
            }),
          ]);

      const saved = state.profile.length
        ? state.profile.map((line, index) => savedRow(line, index))
        : [h("div", "s-empty", "Nothing yet. Tell the agent about your needs, or add a line.")];

      const nodes: Node[] = [h("h3", "", "Memory")];
      if (state.pendingMemory.length) {
        nodes.push(h("div", "s-note", "Waiting for you to choose this site or all sites"), ...state.pendingMemory.map((line) => proposalRow(state, line)));
      }
      nodes.push(...saved, addForm, ...siteSkillRows(state), activityRow(state), clearButton);

      const section = h("section", "s-sec", "", nodes);
      if (editing !== null) setTimeout(() => editInput?.focus(), 0);
      return section;
    },
  };
}
