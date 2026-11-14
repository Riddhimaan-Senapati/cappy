import {
  AdaptRequest,
  AdaptResponse,
  ADAPT_PATH,
  DEFAULT_BACKEND_URL,
  matchesHost,
  type AdaptationId,
} from "@browser-agent/shared";
import { colorFilterSvg, compileAdaptationCss } from "@browser-agent/blocks";
import { Message, PageReady, ToContentMessage } from "../utils/messages";
import { Applied, AppliedMap, KEYS, LastResult, loadProfile, readParsed, setLast } from "../utils/state";

const APPLIED_KEY = KEYS.applied;

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
    console.error("setPanelBehavior failed", err);
  });

  chrome.runtime.onMessage.addListener((raw, sender) => {
    const parsed = Message.safeParse(raw);
    if (!parsed.success) return false;
    const msg = parsed.data;
    if (msg.type === "page-ready" && sender.tab?.id !== undefined) {
      void handlePageReady(sender.tab.id, msg);
    } else if (msg.type === "undo") {
      void handleUndo(msg.adaptationId);
    }
    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void forgetApplied(tabId);
  });
});

async function handlePageReady(tabId: number, msg: PageReady): Promise<void> {
  await forgetApplied(tabId);
  const profile = await loadProfile();
  if (profile.needs.length === 0) return;

  const request = AdaptRequest.safeParse({ url: msg.url, outline: msg.outline, profile });
  if (!request.success) {
    await setLast({ status: "error", url: msg.url, message: "Page details were not valid" });
    return;
  }

  let raw: unknown;
  try {
    const res = await fetch(`${DEFAULT_BACKEND_URL}${ADAPT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
    });
    if (!res.ok) throw new Error(`backend responded ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn("adapt request failed", err);
    await setLast({ status: "error", url: msg.url, message: "Backend unreachable" });
    return;
  }

  const parsed = AdaptResponse.safeParse(raw);
  if (!parsed.success) {
    await setLast({ status: "error", url: msg.url, message: "Backend sent an unexpected response" });
    return;
  }
  const response = parsed.data;
  if (response.kind === "none") {
    await setLast({ status: "none", url: msg.url, reason: response.reason });
    return;
  }
  if (response.kind === "blocked") {
    await setLast({ status: "blocked", url: msg.url, reason: response.reason });
    return;
  }

  const { adaptation } = response;
  const hostname = new URL(msg.url).hostname;
  if (!adaptation.sites.some((pattern) => matchesHost(pattern, hostname))) {
    await setLast({ status: "none", url: msg.url, reason: "Adaptation does not cover this site" });
    return;
  }

  let css: string;
  let svg: string | undefined;
  try {
    css = compileAdaptationCss(adaptation);
    const colorFix = adaptation.blocks.find((b) => b.block === "color_fix");
    svg = colorFix ? colorFilterSvg(colorFix.mode) : undefined;
  } catch (err) {
    console.error("could not compile adaptation", err);
    await setLast({ status: "error", url: msg.url, message: "Could not build this adaptation" });
    return;
  }
  if (!css.trim() && !svg) {
    await setLast({ status: "none", url: msg.url, reason: "Nothing to change on this page" });
    return;
  }

  try {
    if (css.trim()) await chrome.scripting.insertCSS({ target: { tabId }, css });
    if (svg) await sendToTab(tabId, { type: "inject-svg", svg });
    await sendToTab(tabId, {
      type: "show-banner",
      reason: adaptation.reason.text,
      adaptationId: adaptation.id,
    });
  } catch (err) {
    console.error("could not apply adaptation", err);
    if (css.trim()) await chrome.scripting.removeCSS({ target: { tabId }, css }).catch(() => undefined);
    await setLast({ status: "error", url: msg.url, message: "Could not apply this adaptation to the page" });
    return;
  }

  await writeApplied(tabId, { adaptationId: adaptation.id, css });
  await setLast({
    status: "applied",
    url: msg.url,
    tabId,
    adaptationId: adaptation.id,
    reason: adaptation.reason.text,
    blocks: adaptation.blocks.map((b) => b.block),
  });
}

async function handleUndo(adaptationId: AdaptationId): Promise<void> {
  const applied: AppliedMap = (await readParsed("session", APPLIED_KEY, AppliedMap)) ?? {};
  const entry = Object.entries(applied).find(([, a]) => a.adaptationId === adaptationId);
  if (!entry) return;
  const [tabKey, { css }] = entry;
  const tabId = Number(tabKey);

  await chrome.scripting.removeCSS({ target: { tabId }, css }).catch((err: unknown) => {
    console.warn("removeCSS failed, tab may be gone", err);
  });
  await sendToTab(tabId, { type: "remove-banner" }).catch(() => undefined);
  await forgetApplied(tabId);

  const last = await readParsed("session", KEYS.last, LastResult);
  if (last?.status === "applied" && last.adaptationId === adaptationId) {
    await setLast({ status: "undone", url: last.url, adaptationId });
  }
}

async function sendToTab(tabId: number, msg: ToContentMessage): Promise<void> {
  await chrome.tabs.sendMessage(tabId, msg);
}

async function writeApplied(tabId: number, entry: Applied): Promise<void> {
  const applied: AppliedMap = (await readParsed("session", APPLIED_KEY, AppliedMap)) ?? {};
  applied[String(tabId)] = entry;
  await chrome.storage.session.set({ [APPLIED_KEY]: applied });
}

async function forgetApplied(tabId: number): Promise<void> {
  const applied: AppliedMap = (await readParsed("session", APPLIED_KEY, AppliedMap)) ?? {};
  if (!(String(tabId) in applied)) return;
  delete applied[String(tabId)];
  await chrome.storage.session.set({ [APPLIED_KEY]: applied });
}
