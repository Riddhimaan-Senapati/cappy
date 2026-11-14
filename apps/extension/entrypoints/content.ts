import type { AdaptationId, PageOutline } from "@browser-agent/shared";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";
import { Message, ToContentMessage } from "../utils/messages";

const FILTER_ID = "adaptive-agent-filters";

const BANNER_CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px;
    padding: 14px 20px; background: #1d1d1f; color: #ffffff;
    font: 500 18px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  }
  .text { flex: 1 1 320px; margin: 0; }
  button {
    min-height: 44px; min-width: 96px; padding: 8px 18px; border-radius: 8px;
    border: 2px solid #ffffff; background: #ffffff; color: #1d1d1f;
    font: 700 18px system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer;
  }
  button:focus-visible { outline: 3px solid #ffd60a; outline-offset: 2px; }
`;

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main(ctx) {
    let banner: ShadowRootContentScriptUi<void> | undefined;

    const removeAdaptationUi = () => {
      banner?.remove();
      banner = undefined;
      document.getElementById(FILTER_ID)?.remove();
    };

    const showBanner = async (reason: string, adaptationId: AdaptationId) => {
      banner?.remove();
      banner = await createShadowRootUi(ctx, {
        name: "adaptive-agent-banner",
        position: "inline",
        anchor: "body",
        append: "first",
        onMount(container) {
          const style = document.createElement("style");
          style.textContent = BANNER_CSS;
          const bar = document.createElement("div");
          bar.className = "bar";
          bar.setAttribute("role", "status");
          const text = document.createElement("p");
          text.className = "text";
          text.textContent = `Changed this page for you: ${reason}`;
          const undo = document.createElement("button");
          undo.type = "button";
          undo.textContent = "Undo";
          undo.addEventListener("click", () => {
            void chrome.runtime.sendMessage(Message.parse({ type: "undo", adaptationId }));
          });
          bar.append(text, undo);
          container.append(style, bar);
        },
      });
      banner.mount();
    };

    const injectFilters = (svg: string) => {
      if (document.getElementById(FILTER_ID)) return;
      const holder = document.createElement("div");
      holder.id = FILTER_ID;
      holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      const template = document.createElement("template");
      template.innerHTML = svg;
      holder.append(template.content);
      document.body.append(holder);
    };

    chrome.runtime.onMessage.addListener((raw) => {
      const parsed = ToContentMessage.safeParse(raw);
      if (!parsed.success) return false;
      const msg = parsed.data;
      switch (msg.type) {
        case "show-banner":
          void showBanner(msg.reason, msg.adaptationId);
          break;
        case "inject-svg":
          injectFilters(msg.svg);
          break;
        case "remove-banner":
          removeAdaptationUi();
          break;
      }
      return false;
    });

    void chrome.runtime
      .sendMessage(Message.parse({ type: "page-ready", url: location.href, outline: buildOutline() }))
      .catch(() => undefined);
  },
});

function buildOutline(): PageOutline {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120))
    .filter((text) => text.length > 0)
    .slice(0, 30);
  return {
    title: document.title.slice(0, 200),
    headings,
    forms: document.forms.length,
    images: document.images.length,
    videos: document.querySelectorAll("video").length,
    canvases: document.querySelectorAll("canvas").length,
  };
}
