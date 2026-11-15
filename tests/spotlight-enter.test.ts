import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installDom } from "./dom-setup.js";
import { DEFAULTS } from "../extension/src/storage.js";
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
const SCREEN_READER = "label every control so a screen reader can find it";
const PREFIX = "make the text big";
const FULL = "make the text bigger and bolder for a screen reader";

interface Asked {
  message: string;
  fresh: boolean;
}

function installChrome() {
  globalThis.chrome = {
    runtime: { id: "test", sendMessage: async () => true },
    storage: {
      local: { get: async () => ({ ...DEFAULTS }), set: async () => undefined },
      onChanged: { addListener() {}, removeListener() {} },
    },
  } as unknown as typeof chrome;
}

async function openBar() {
  installChrome();
  const { Spotlight } = await import("../extension/src/overlay/spotlight.js");
  const asked: Asked[] = [];
  const accepted: string[] = [];
  let readAloud = 0;
  const deps = {
    ask: (message: string, fresh: boolean) => asked.push({ message, fresh }),
    stop() {},
    dequeue() {},
    clearTarget() {},
    pick() {},
    pointed: () => null,
    markTarget() {},
    listChanges: () => [],
    history: () => [],
    reapply: async () => undefined,
    revert: async () => undefined,
    revertAll: async () => undefined,
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
  assert.ok(input, "bar input exists");
  input.focus();
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new view.KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init });
    return bar.handleKey(event);
  };
  // Characters land in the field immediately. The suggestion list rebuilds on `input`,
  // which a fast run can still be waiting on when Enter is handled.
  const fastType = (text: string, listCatchesUpAt: number | null = null) => {
    input.value = "";
    for (let i = 0; i < text.length; i++) {
      input.value += text[i];
      if (listCatchesUpAt === i + 1) input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
    }
  };
  return {
    bar,
    input,
    shadow,
    asked,
    accepted,
    readAloud: () => readAloud,
    press,
    fastType,
    close() {
      bar.destroy();
      host.remove();
    },
  };
}

describe("bar Enter", () => {
  it("submits the typed text when fast typing outruns the suggestion list", async () => {
    const suggestion = await openBar();
    try {
      suggestion.bar.setNudge(FORM_SUGGESTION);
      suggestion.fastType(SCREEN_READER);
      suggestion.press("Enter");
      assert.deepEqual(suggestion.asked, [{ message: SCREEN_READER, fresh: false }]);
      assert.deepEqual(suggestion.accepted, []);
    } finally {
      suggestion.close();
    }

    const prefix = await openBar();
    try {
      prefix.fastType(FULL, PREFIX.length);
      assert.equal(prefix.input.value, FULL);
      prefix.press("Enter");
      assert.deepEqual(prefix.asked, [{ message: FULL, fresh: false }]);
    } finally {
      prefix.close();
    }
  });

  it("submits the field when a row is only highlighted, and runs one that was picked", async () => {
    const highlighted = await openBar();
    try {
      highlighted.fastType("read this", "read this".length);
      highlighted.press("Enter");
      assert.deepEqual(highlighted.asked, [{ message: "read this", fresh: false }]);
      assert.equal(highlighted.readAloud(), 0);
    } finally {
      highlighted.close();
    }

    const arrows = await openBar();
    try {
      arrows.bar.setNudge(FORM_SUGGESTION);
      arrows.press("ArrowDown");
      arrows.press("Enter");
      assert.deepEqual(arrows.asked, [{ message: FORM_SUGGESTION.text, fresh: false }]);
      assert.deepEqual(arrows.accepted, [FORM_SUGGESTION.text]);
    } finally {
      arrows.close();
    }

    const slash = await openBar();
    try {
      const sent: unknown[] = [];
      chrome.runtime.sendMessage = (async (message: unknown) => {
        sent.push(message);
        return { ok: true };
      }) as typeof chrome.runtime.sendMessage;
      slash.fastType("/profile new Personal", "/pro".length);
      assert.equal(slash.input.value, "/profile new Personal");
      slash.press("Enter");
      assert.deepEqual(slash.asked, []);
      assert.deepEqual(sent, [{ kind: "profileAction", action: "create", name: "Personal" }]);
    } finally {
      slash.close();
    }

    const click = await openBar();
    try {
      click.bar.setNudge(FORM_SUGGESTION);
      const row = [...click.shadow.querySelectorAll(".item")].find((node) => node.textContent?.includes(FORM_SUGGESTION.text));
      assert.ok(row instanceof HTMLElement, "suggestion row exists");
      row.click();
      assert.deepEqual(click.asked, [{ message: FORM_SUGGESTION.text, fresh: false }]);
      assert.deepEqual(click.accepted, [FORM_SUGGESTION.text]);
    } finally {
      click.close();
    }
  });
});
