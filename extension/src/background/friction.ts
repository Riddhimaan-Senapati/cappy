import { sendToTab } from "./agent.js";

export function registerFriction() {
  chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor, oldZoomFactor }) => {
    if (newZoomFactor <= oldZoomFactor) return;
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (!tab.active || !tab.url || !/^https?:\/\//.test(tab.url)) return;
        return sendToTab(tabId, { kind: "frictionEvent", event: "zoom-in" });
      })
      .catch(() => undefined);
  });
}
