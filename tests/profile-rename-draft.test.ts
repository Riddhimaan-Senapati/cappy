import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installDom } from "./dom-setup.js";
import { DEFAULTS } from "../extension/src/storage.js";

installDom();

const messages: unknown[] = [];
Object.assign(globalThis, {
  chrome: {
    runtime: {
      sendMessage: async (message: unknown) => {
        messages.push(message);
        return { ok: true };
      },
    },
  },
});

const { createProfilesView } = await import("../extension/src/ui/profiles.js");

function stateNamed(name: string) {
  return { ...DEFAULTS, activeProfileId: "default", profiles: { default: { name } } };
}

// The rename field sits behind Manage; open it, then paint again as the settings view would.
function managed(view: (state: ReturnType<typeof stateNamed>) => HTMLElement, state: ReturnType<typeof stateNamed>) {
  const closed = view(state);
  const manage = [...closed.querySelectorAll("button")].find((button) => button.textContent === "Manage");
  assert.ok(manage);
  manage.click();
  return view(state);
}

function renameInput(root: ParentNode) {
  const input = root.querySelector<HTMLInputElement>('[aria-label="Current profile name"]');
  assert.ok(input);
  return input;
}

describe("profile rename draft", () => {
  it("keeps a typed name across a repaint", () => {
    const view = createProfilesView(() => undefined);
    const first = managed(view, stateNamed("Default"));
    const input = renameInput(first);
    input.value = "Focus";
    input.dispatchEvent(new window.Event("input"));
    const second = view(stateNamed("Default"));
    assert.equal(renameInput(second).value, "Focus");
  });

  it("shows the stored name when the field has not been edited", () => {
    const view = createProfilesView(() => undefined);
    assert.equal(renameInput(managed(view, stateNamed("My setup"))).value, "My setup");
  });

  it("clears the draft after the rename is saved", async () => {
    const latest = stateNamed("Default");
    let node: HTMLElement = document.createElement("div");
    const view = createProfilesView(() => {
      const next = view(latest);
      node.replaceWith(next);
      node = next;
    });
    node = managed(view, latest);
    document.body.append(node);
    const input = renameInput(node);
    input.value = "Focus";
    input.dispatchEvent(new window.Event("input"));
    node.querySelector<HTMLButtonElement>("form button")?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(messages.at(-1) && (messages.at(-1) as { name?: string }).name, "Focus");
    assert.equal(renameInput(node).value, "Default");
  });
});
