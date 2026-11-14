import { acceptProposal, addLine, clearAllMemory, editLine, forgetLine, rejectProposal } from "../memory.js";
import { save, type StoredState } from "../storage.js";
import { h } from "./dom.js";

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

  const proposalRow = (line: string) =>
    h("div", "s-row", "", [
      h("div", "grow", line),
      button("Accept", "s-link", () => void acceptProposal(line)),
      button("Reject", "s-link", () => void rejectProposal(line)),
    ]);

  return {
    render(state, toggleRow) {
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
        nodes.push(h("div", "s-note", "Waiting for your approval"), ...state.pendingMemory.map(proposalRow));
      }
      nodes.push(...saved, addForm, toggleRow("Ask before remembering", "New memories wait for your approval instead of saving straight away.", state.askBeforeRemember, (value) => void save({ askBeforeRemember: value })), clearButton);

      const section = h("section", "s-sec", "", nodes);
      if (editing !== null) setTimeout(() => editInput?.focus(), 0);
      return section;
    },
  };
}
