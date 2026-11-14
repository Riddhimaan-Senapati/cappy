import type { ActiveChange } from "../../shared/adaptation.js";
import type { BackgroundRequest, ContentRequest, ContentResponse, StatusInfo } from "./messages.js";
import { adoptStyles, h, icon } from "./ui/dom.js";
import { renderSettings } from "./ui/settings.js";
import { POPUP_CSS, SETTINGS_CSS, TOKENS } from "./ui/theme.js";

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function toTab<T>(request: ContentRequest): Promise<T> {
  const id = await activeTabId();
  if (!id) throw new Error("No active tab");
  const response: ContentResponse | undefined = await chrome.tabs.sendMessage(id, request);
  if (!response?.ok) throw new Error(response && !response.ok ? response.error : "No response from the page");
  return response.result as T;
}

adoptStyles(document, TOKENS + SETTINGS_CSS + POPUP_CSS);

const root = h("div");
document.body.append(
  h("div", "pop-head", "", [h("div", "pop-logo", "", [icon("sparkle", 16)]), h("div", "", "", [h("h1", "", "Adaptive Agent"), h("small", "", "Your browser, adapted to you")])]),
  root,
);

renderSettings(root, {
  listChanges: () => toTab<ActiveChange[]>({ kind: "list" }),
  revert: async (id) => void (await toTab({ kind: "tool", name: "revert_change", input: { id } })),
  openDebug: async () => {
    const window = await chrome.windows.getCurrent();
    if (window.id) await chrome.sidePanel.open({ windowId: window.id });
    globalThis.close();
  },
  openShortcuts: () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }),
  setKey: (provider, key, baseURL) => void chrome.runtime.sendMessage({ kind: "setKey", provider, key, ...(baseURL != null ? { baseURL } : {}) } satisfies BackgroundRequest),
  signIn: () => void chrome.runtime.sendMessage({ kind: "chatgptLogin" } satisfies BackgroundRequest),
  signOut: () => void chrome.runtime.sendMessage({ kind: "chatgptLogout" } satisfies BackgroundRequest),
  getStatus: async () => (await chrome.runtime.sendMessage({ kind: "status" } satisfies BackgroundRequest)) as StatusInfo,
});
