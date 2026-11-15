import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installDom } from "./dom-setup.js";
import { DEFAULTS, type StoredState } from "../extension/src/storage.js";
import type { ActiveChange } from "../shared/adaptation.js";
import type { Suggestion } from "../shared/protocol.js";
import type { SpotlightDeps } from "../extension/src/overlay/spotlight.js";

installDom();
const view = globalThis.window;
globalThis.requestAnimationFrame ??= view.requestAnimationFrame.bind(view);
globalThis.cancelAnimationFrame ??= view.cancelAnimationFrame.bind(view);
globalThis.addEventListener ??= view.addEventListener.bind(view);
globalThis.removeEventListener ??= view.removeEventListener.bind(view);
globalThis.HTMLInputElement ??= view.HTMLInputElement;

const originalChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = originalChrome;
});

const FORM_SUGGESTION: Suggestion = {
  text: "make form controls easier to tap",
  reason: "Small targets on this form",
  scope: "site",
  memory: null,
};
const OTHER_SUGGESTION: Suggestion = {
  text: "make the text bigger",
  reason: "You zoomed in",
  scope: "everywhere",
  memory: null,
};
const SCREEN_READER = "label every control so a screen reader can find it";
const LASTING = "keep the labels";

interface Asked {
  message: string;
  fresh: boolean;
}

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

const PAGE_CHANGE = {
  id: "bigger-text",
  summary: "Larger text",
  reason: "Request",
  css: null,
  dom: null,
  block: null,
  scope: "site",
  appliedAt: 1,
} as ActiveChange;

async function openBar(stored: Partial<StoredState> = {}, changes: ActiveChange[] = []) {
  const data = { ...DEFAULTS, ...stored };
  const listeners: StorageListener[] = [];
  globalThis.chrome = {
    runtime: {
      id: "test",
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: {
      local: {
        get: async () => data,
        set: async (patch: Partial<StoredState>) => Object.assign(data, patch),
      },
      onChanged: {
        addListener(fn: StorageListener) { listeners.push(fn); },
        removeListener(fn: StorageListener) {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  } as unknown as typeof chrome;
  const { Spotlight } = await import("../extension/src/overlay/spotlight.js");
  const asked: Asked[] = [];
  const accepted: string[] = [];
  let readAloud = 0;
  const reverted: string[] = [];
  const deps = {
    ask: (message: string, fresh: boolean) => asked.push({ message, fresh }),
    stop() {},
    dequeue() {},
    clearTarget() {},
    pick() {},
    pointed: () => null,
    markTarget() {},
    listChanges: () => changes,
    history: () => [],
    reapply: async () => undefined,
    revert: async (id: string) => { reverted.push(id); },
    revertAll: async () => { reverted.push("all"); },
    enableMicrophone() {},
    openDebug() {},
    readAloud: () => { readAloud += 1; },
    stopSpeaking() {},
    isSpeaking: () => false,
    settings: {
      listChanges: async () => [],
      revert: async () => undefined,
      openDebug() {},
      openShortcuts() {},
      getStatus: async () => ({ connected: false, busy: false }),
      setKey() {},
      signIn() {},
      signOut() {},
    },
    ensureAlive: () => true,
    suggest: () => new Promise<Suggestion | null>(() => undefined),
    acceptSuggestion: (suggestion: Suggestion) => accepted.push(suggestion.text),
    dismissSuggestion() {},
  } satisfies SpotlightDeps;
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const bar = new Spotlight(shadow, deps, () => undefined);
  await bar.show();
  const input = shadow.querySelector("input");
  assert.ok(input instanceof view.HTMLInputElement, "bar input exists");
  input.focus();
  const press = (key: string, init: KeyboardEventInit = {}, keyCode?: number) => {
    const event = new view.KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init });
    if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { configurable: true, get: () => keyCode });
    return bar.handleKey(event);
  };
  const type = (text: string) => {
    input.value = "";
    for (const char of text) {
      input.value += char;
      input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
    }
  };
  const paste = (text: string) => {
    input.value = text;
    input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  };
  return {
    bar,
    input,
    shadow,
    stored: data,
    asked,
    accepted,
    reverted,
    readAloud: () => readAloud,
    press,
    type,
    paste,
    emitStorage(changes: Record<string, chrome.storage.StorageChange>) {
      for (const listener of listeners) listener(changes, "local");
    },
    close() {
      bar.destroy();
      host.remove();
    },
  };
}

function selectedRows(shadow: ShadowRoot): HTMLElement[] {
  return [...shadow.querySelectorAll<HTMLElement>(".item.sel")];
}

describe("bar Enter", () => {
  it("does not treat the nudge as selected when the field is empty", async () => {
    const box = await openBar();
    try {
      box.bar.setNudge(FORM_SUGGESTION);
      const input = box.input;
      assert.equal(input.getAttribute("role"), "combobox");
      assert.equal(input.getAttribute("aria-expanded"), "true");
      assert.equal(input.getAttribute("aria-controls"), box.shadow.querySelector("[role=listbox]")?.id);
      assert.equal(input.hasAttribute("aria-activedescendant"), false);
      const options = [...box.shadow.querySelectorAll<HTMLElement>("[role=option]")];
      assert.ok(options.length > 0);
      assert.ok(options.every((option) => option.id && option.getAttribute("aria-selected") === "false"));
      assert.deepEqual(selectedRows(box.shadow), []);
      assert.equal(box.press("Enter"), true);
      assert.deepEqual(box.asked, []);
      assert.deepEqual(box.accepted, []);
    } finally {
      box.close();
    }
  });

  it("runs a row after ArrowDown or a click, and marks only that row selected", async () => {
    const arrows = await openBar();
    try {
      arrows.bar.setNudge(FORM_SUGGESTION);
      arrows.press("ArrowDown");
      const picked = selectedRows(arrows.shadow);
      assert.equal(picked.length, 1);
      assert.match(picked[0].textContent ?? "", /make form controls easier to tap/);
      assert.equal(picked[0].getAttribute("aria-selected"), "true");
      assert.equal(arrows.input.getAttribute("aria-activedescendant"), picked[0].id);
      arrows.press("Enter");
      assert.deepEqual(arrows.asked, [{ message: FORM_SUGGESTION.text, fresh: false }]);
      assert.deepEqual(arrows.accepted, [FORM_SUGGESTION.text]);
    } finally {
      arrows.close();
    }

    const click = await openBar();
    try {
      click.bar.setNudge(FORM_SUGGESTION);
      assert.deepEqual(selectedRows(click.shadow), []);
      const row = [...click.shadow.querySelectorAll(".item")].find((node) => node.textContent?.includes(FORM_SUGGESTION.text));
      assert.ok(row instanceof HTMLElement, "suggestion row exists");
      row.click();
      assert.deepEqual(click.asked, [{ message: FORM_SUGGESTION.text, fresh: false }]);
      assert.deepEqual(click.accepted, [FORM_SUGGESTION.text]);
    } finally {
      click.close();
    }
  });

  it("sends the field when typing or paste replaces a pick", async () => {
    const typed = await openBar();
    try {
      typed.bar.setNudge(FORM_SUGGESTION);
      typed.press("ArrowDown");
      assert.equal(selectedRows(typed.shadow).length, 1);
      typed.type(SCREEN_READER);
      assert.deepEqual(selectedRows(typed.shadow), []);
      assert.equal(typed.input.hasAttribute("aria-activedescendant"), false);
      typed.press("Enter");
      assert.deepEqual(typed.asked, [{ message: SCREEN_READER, fresh: false }]);
      assert.deepEqual(typed.accepted, []);
    } finally {
      typed.close();
    }

    const pasted = await openBar();
    try {
      pasted.bar.setNudge(FORM_SUGGESTION);
      pasted.press("ArrowDown");
      pasted.paste(SCREEN_READER);
      assert.deepEqual(selectedRows(pasted.shadow), []);
      pasted.press("Enter");
      assert.deepEqual(pasted.asked, [{ message: SCREEN_READER, fresh: false }]);
      assert.deepEqual(pasted.accepted, []);
    } finally {
      pasted.close();
    }
  });

  it("keeps a pick on the same id across a re-render and drops it when that id is gone", async () => {
    const kept = await openBar({ lastingSuggestion: LASTING });
    try {
      kept.bar.setNudge(FORM_SUGGESTION);
      kept.press("ArrowDown");
      kept.press("ArrowDown");
      assert.match(selectedRows(kept.shadow)[0]?.textContent ?? "", /keep the labels/);
      kept.bar.setNudge(OTHER_SUGGESTION);
      const picked = selectedRows(kept.shadow);
      assert.equal(picked.length, 1);
      assert.match(picked[0].textContent ?? "", /keep the labels/);
      assert.doesNotMatch(picked[0].textContent ?? "", /make the text bigger/);
      kept.press("Enter");
      assert.deepEqual(kept.asked, [{ message: LASTING, fresh: false }]);
      assert.deepEqual(kept.accepted, []);
    } finally {
      kept.close();
    }

    const gone = await openBar({ lastingSuggestion: LASTING });
    try {
      gone.bar.setNudge(FORM_SUGGESTION);
      gone.press("ArrowDown");
      assert.match(selectedRows(gone.shadow)[0]?.textContent ?? "", /make form controls easier to tap/);
      gone.bar.setNudge(null);
      assert.deepEqual(selectedRows(gone.shadow), []);
      gone.press("Enter");
      assert.deepEqual(gone.asked, []);
    } finally {
      gone.close();
    }
  });

  it("clears the pick when storage changes", async () => {
    const box = await openBar();
    try {
      box.bar.setNudge(FORM_SUGGESTION);
      box.press("ArrowDown");
      assert.equal(selectedRows(box.shadow).length, 1);
      box.emitStorage({ nudgedAt: { newValue: {} } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(selectedRows(box.shadow), []);
      assert.equal(box.press("Enter"), true);
      assert.deepEqual(box.asked, []);
      assert.deepEqual(box.accepted, []);
    } finally {
      box.close();
    }
  });

  it("lets the pointer hover a row without choosing it", async () => {
    const box = await openBar();
    try {
      box.type("read this");
      const command = [...box.shadow.querySelectorAll<HTMLElement>(".item")].find((row) => row.textContent?.includes("Read this page aloud"));
      assert.ok(command, "read-aloud row exists");
      command.dispatchEvent(new view.PointerEvent("pointermove", { bubbles: true }));
      assert.deepEqual(selectedRows(box.shadow), []);
      assert.ok([...box.shadow.querySelectorAll("[role=option]")].every((row) => row.getAttribute("aria-selected") === "false"));
      box.press("Enter");
      assert.deepEqual(box.asked, [{ message: "read this", fresh: false }]);
      assert.equal(box.readAloud(), 0);
    } finally {
      box.close();
    }
  });

  it("ignores Enter while an IME composition is committing", async () => {
    const box = await openBar();
    try {
      box.type(SCREEN_READER);
      assert.equal(box.press("Enter", {}, 229), false);
      assert.equal(box.press("Enter", { isComposing: true }), false);
      assert.deepEqual(box.asked, []);
      box.press("Enter");
      assert.deepEqual(box.asked, [{ message: SCREEN_READER, fresh: false }]);
    } finally {
      box.close();
    }
  });

  it("sends Shift+Enter as a fresh request from the field", async () => {
    const box = await openBar();
    try {
      box.type(SCREEN_READER);
      box.press("Enter", { shiftKey: true });
      assert.deepEqual(box.asked, [{ message: SCREEN_READER, fresh: true }]);
    } finally {
      box.close();
    }
  });

  it("sends a typed command name to the model and still runs a slash command", async () => {
    const named = await openBar({}, [PAGE_CHANGE]);
    try {
      named.type("settings");
      const settings = [...named.shadow.querySelectorAll(".item")].find((row) => row.textContent?.includes("Settings"));
      assert.ok(settings, "settings row exists");
      assert.equal(settings.classList.contains("sel"), false);
      named.press("Enter");
      assert.deepEqual(named.asked, [{ message: "settings", fresh: false }]);
      assert.equal(named.input.readOnly, false);
    } finally {
      named.close();
    }

    const undo = await openBar({}, [PAGE_CHANGE]);
    try {
      undo.type("undo");
      const row = [...undo.shadow.querySelectorAll(".item")].find((item) => item.textContent?.includes("Undo larger text"));
      assert.ok(row, "undo row exists");
      assert.equal(row.classList.contains("sel"), false);
      undo.press("Enter");
      assert.deepEqual(undo.asked, [{ message: "undo", fresh: false }]);
      assert.deepEqual(undo.reverted, []);
    } finally {
      undo.close();
    }

    const slash = await openBar({}, [PAGE_CHANGE]);
    try {
      slash.type("/settings");
      slash.press("Enter");
      assert.deepEqual(slash.asked, []);
      assert.equal(slash.input.readOnly, true);
    } finally {
      slash.close();
    }

    const slashUndo = await openBar({}, [PAGE_CHANGE]);
    try {
      slashUndo.type("/undo");
      slashUndo.press("Enter");
      assert.deepEqual(slashUndo.asked, []);
      assert.deepEqual(slashUndo.reverted, ["bigger-text"]);
    } finally {
      slashUndo.close();
    }
  });

  it("runs a slash command from the live field", async () => {
    const box = await openBar();
    try {
      const sent: unknown[] = [];
      chrome.runtime.sendMessage = (async (message: unknown) => {
        sent.push(message);
        return { ok: true };
      }) as typeof chrome.runtime.sendMessage;
      box.input.value = "/pro";
      box.input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
      box.input.value = "/profile new Personal";
      box.press("Enter");
      assert.deepEqual(box.asked, []);
      assert.deepEqual(sent, [{ kind: "profileAction", action: "create", name: "Personal" }]);
    } finally {
      box.close();
    }
  });
});

describe("bar Focus mode", () => {
  const RULE = { ...PAGE_CHANGE, id: "hide-shorts", summary: "Hide Shorts", schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" } } as ActiveChange;

  it("lists Focus mode with how many rules it turns on, and switches it", async () => {
    const box = await openBar({ siteChanges: { "https://www.youtube.com": [RULE] }, globalChanges: [{ ...RULE, id: "dim-feed", scope: "everywhere" }] });
    try {
      box.type("focus");
      const row = [...box.shadow.querySelectorAll(".item")].find((item) => item.textContent?.includes("Turn on Focus mode"));
      assert.ok(row, "focus mode row exists");
      assert.ok(row.textContent?.includes("all 2 focus rules on now"));
      (row as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(box.stored.focusMode, true);
      assert.deepEqual(box.asked, []);
    } finally {
      box.close();
    }
  });

  it("offers to turn it off while it is on", async () => {
    const box = await openBar({ focusMode: true });
    try {
      box.type("focus");
      const row = [...box.shadow.querySelectorAll(".item")].find((item) => item.textContent?.includes("Turn off Focus mode"));
      assert.ok(row, "turn off row exists");
      assert.ok(row.textContent?.includes("rules go back to their times"));
    } finally {
      box.close();
    }
  });
});
