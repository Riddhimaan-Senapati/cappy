import {
  AdaptRequest,
  AdaptResponse,
  ADAPT_PATH,
  DEFAULT_BACKEND_URL,
  NeedId,
  matchesHost,
  type Adaptation,
  type AdaptationId,
  type Profile,
} from "@browser-agent/shared";
import { colorFilterSvg, compileAdaptationCss } from "@browser-agent/blocks";
import { Gesture, Message, PageReady, ToContentMessage, type OutlineReply } from "../utils/messages";
import {
  Applied,
  AppliedMap,
  KEYS,
  LastResult,
  Verification,
  VERIFICATION_KEY,
  loadProfile,
  readParsed,
  saveProfile,
  setLast,
} from "../utils/state";
import { forget, lookup, readSaved, remember, updateSaved } from "../utils/saved-changes";
import { startFriction } from "../utils/friction";
import { buildRequestBody, parseOutlineReply, postRequest } from "../utils/request";
import { reasonBadge } from "../utils/badge";
import { verifyAdaptation } from "../utils/verify";

const APPLIED_KEY = KEYS.applied;
const FRICTION_PROMPT = "Make text bigger on every site?";

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
    console.error("setPanelBehavior failed", err);
  });

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const parsed = Message.safeParse(raw);
    if (!parsed.success) return false;
    const msg = parsed.data;
    if (msg.type === "page-ready" && sender.tab?.id !== undefined) {
      void handlePageReady(sender.tab.id, msg);
    } else if (msg.type === "undo") {
      void handleUndo(msg.adaptationId);
    } else if (msg.type === "gesture") {
      void handleGesture(msg);
    } else if (msg.type === "user-request") {
      void handleUserRequest(msg.text).finally(() => sendResponse({ ok: true }));
      return true;
    } else if (msg.type === "friction-accept" && sender.tab?.id !== undefined) {
      void handleFrictionAccept(sender.tab.id);
    }
    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void forgetApplied(tabId);
  });

  startFriction(promptFriction);
});

async function handlePageReady(tabId: number, msg: PageReady): Promise<void> {
  await forgetApplied(tabId);
  const profile = await loadProfile();
  if (profile.needs.length === 0) return notifyDone(tabId);

  const host = hostOf(msg.url);
  const saved = host ? lookup(await readSaved(), host, profile.version) : undefined;
  if (saved) {
    const restored = await applyResponse(tabId, msg.url, { kind: "adaptation", adaptation: saved }, profile, {
      restored: true,
    });
    if (restored) return;
  }

  const request = AdaptRequest.safeParse({ url: msg.url, outline: msg.outline, profile });
  if (!request.success) {
    await setLast({ status: "error", url: msg.url, message: "Page details were not valid" });
    return notifyDone(tabId);
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
    return notifyDone(tabId);
  }

  const parsed = AdaptResponse.safeParse(raw);
  if (!parsed.success) {
    await setLast({ status: "error", url: msg.url, message: "Backend sent an unexpected response" });
    return notifyDone(tabId);
  }
  const applied = await applyResponse(tabId, msg.url, parsed.data, profile);
  if (!applied) await notifyDone(tabId);
}

export async function applyResponse(
  tabId: number,
  url: string,
  response: AdaptResponse,
  profile: Profile,
  options: { restored?: boolean } = {},
): Promise<boolean> {
  const restored = options.restored === true;
  if (response.kind === "none") {
    await setLast({ status: "none", url, reason: response.reason });
    return false;
  }
  if (response.kind === "blocked") {
    await setLast({ status: "blocked", url, reason: response.reason });
    return false;
  }

  const { adaptation } = response;
  const hostname = new URL(url).hostname;
  if (!adaptation.sites.some((pattern) => matchesHost(pattern, hostname))) {
    await setLast({ status: "none", url, reason: "Adaptation does not cover this site" });
    return false;
  }

  let css: string;
  let svg: string | undefined;
  try {
    css = compileAdaptationCss(adaptation);
    const colorFix = adaptation.blocks.find((b) => b.block === "color_fix");
    svg = colorFix ? colorFilterSvg(colorFix.mode) : undefined;
  } catch (err) {
    console.error("could not compile adaptation", err);
    await setLast({ status: "error", url, message: "Could not build this adaptation" });
    return false;
  }
  if (!css.trim() && !svg) {
    await setLast({ status: "none", url, reason: "Nothing to change on this page" });
    return false;
  }

  const badged = reasonBadge(adaptation.reason.text, adaptation.reason.needId, profile);
  const reason = restored ? `Restored: ${badged}`.slice(0, 200) : badged;

  // Verification captures the "before" screenshot, so it has to own the apply call.
  // A restored change was verified when it was first saved, so it skips the loop and the backend.
  const applyFn = async (): Promise<boolean> => {
    await clearTabCss(tabId);
    try {
      if (css.trim()) await chrome.scripting.insertCSS({ target: { tabId }, css });
      if (svg) await sendToTab(tabId, { type: "inject-svg", svg });
      await sendToTab(tabId, { type: "show-banner", reason, adaptationId: adaptation.id });
    } catch (err) {
      console.error("could not apply adaptation", err);
      if (css.trim()) await chrome.scripting.removeCSS({ target: { tabId }, css }).catch(() => undefined);
      await setLast({ status: "error", url, message: "Could not apply this adaptation to the page" });
      return false;
    }
    await writeApplied(tabId, { adaptationId: adaptation.id, css });
    if (adaptation.blocks.some((b) => b.block === "form_fixer")) {
      await sendToTab(tabId, { type: "apply-runtime", adaptationId: adaptation.id, blocks: adaptation.blocks }).catch(
        (err: unknown) => console.warn("runtime blocks failed to apply", err),
      );
    }
    await setLast({
      status: "applied",
      url,
      tabId,
      adaptationId: adaptation.id,
      reason,
      blocks: adaptation.blocks.map((b) => b.block),
      restored,
    });
    return true;
  };

  const undoFn = async () => {
    if (css.trim()) await chrome.scripting.removeCSS({ target: { tabId }, css }).catch(() => undefined);
    await sendToTab(tabId, { type: "remove-banner" }).catch(() => undefined);
    await forgetApplied(tabId);
    await setLast({ status: "undone", url, adaptationId: adaptation.id });
  };

  if (restored) return applyFn();

  void verifyAdaptation(tabId, adaptation, applyFn, undoFn)
    .then(() => rememberIfVerified(url, adaptation, profile.version))
    .catch((err: unknown) => {
      console.error("verification failed", err);
    });
  return true;
}

async function rememberIfVerified(url: string, adaptation: Adaptation, profileVersion: number): Promise<void> {
  const record = await readParsed("session", VERIFICATION_KEY, Verification);
  if (!record || record.adaptationId !== adaptation.id || record.state !== "verified") return;
  const host = hostOf(url);
  if (!host) return;
  await updateSaved((saved) => remember(saved, host, adaptation, profileVersion));
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function handleUserRequest(text: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) {
    await setLast({ status: "error", url: "", message: "No active tab to change" });
    return;
  }
  const tabId = tab.id;
  const reply = await requestOutline(tabId);
  if (!reply) {
    await setLast({
      status: "error",
      url: tab.url ?? "",
      message: "This page cannot be read. Open a normal web page and try again.",
    });
    return;
  }

  const profile = await loadProfile();
  const body = buildRequestBody(reply, profile, text);
  let raw: unknown;
  try {
    raw = await postRequest(body);
  } catch (err) {
    console.warn("request failed", err);
    await setLast({ status: "error", url: reply.url, message: "Backend unreachable" });
    return;
  }
  const parsed = AdaptResponse.safeParse(raw);
  if (!parsed.success) {
    await setLast({ status: "error", url: reply.url, message: "Backend sent an unexpected response" });
    return;
  }
  await applyResponse(tabId, reply.url, parsed.data, profile);
}

async function handleFrictionAccept(tabId: number): Promise<void> {
  const profile = await loadProfile();
  if (!profile.needs.some((n) => n.kind === "text_size")) {
    await saveProfile({
      version: profile.version + 1,
      summary: profile.summary,
      needs: [
        ...profile.needs,
        {
          id: NeedId.parse(`f-${crypto.randomUUID().slice(0, 8)}`),
          kind: "text_size",
          detail: "zoomed in repeatedly",
          source: "friction",
        },
      ],
    });
  }
  await chrome.tabs.setZoom(tabId, 1).catch((err: unknown) => {
    console.warn("could not reset zoom", err);
  });
  const reply = await requestOutline(tabId);
  if (reply) await handlePageReady(tabId, { type: "page-ready", url: reply.url, outline: reply.outline });
}

async function promptFriction(tabId: number): Promise<void> {
  const profile = await loadProfile();
  if (profile.needs.some((n) => n.kind === "text_size")) return;
  await sendToTab(tabId, { type: "friction-prompt", text: FRICTION_PROMPT }).catch(() => undefined);
}

async function requestOutline(tabId: number): Promise<OutlineReply | undefined> {
  const raw: unknown = await chrome.tabs
    .sendMessage(tabId, ToContentMessage.parse({ type: "get-outline" }))
    .catch(() => undefined);
  return parseOutlineReply(raw);
}

async function notifyDone(tabId: number): Promise<void> {
  await sendToTab(tabId, { type: "adapt-done" }).catch(() => undefined);
}

async function handleUndo(adaptationId: AdaptationId): Promise<void> {
  const applied: AppliedMap = (await readParsed("session", APPLIED_KEY, AppliedMap)) ?? {};
  const entry = Object.entries(applied).find(([, a]) => a.adaptationId === adaptationId);
  if (!entry) return;
  const [tabKey, { css }] = entry;
  const tabId = Number(tabKey);

  const host = hostOf((await chrome.tabs.get(tabId).catch(() => undefined))?.url);
  if (host) await updateSaved((saved) => forget(saved, host)).catch((err: unknown) => console.warn("forget failed", err));

  await chrome.scripting.removeCSS({ target: { tabId }, css }).catch((err: unknown) => {
    console.warn("removeCSS failed, tab may be gone", err);
  });
  await sendToTab(tabId, { type: "remove-banner" }).catch(() => undefined);
  await sendToTab(tabId, { type: "undo-runtime" }).catch(() => undefined);
  await forgetApplied(tabId);

  const last = await readParsed("session", KEYS.last, LastResult);
  if (last?.status === "applied" && last.adaptationId === adaptationId) {
    await setLast({ status: "undone", url: last.url, adaptationId });
  }
}

async function handleGesture(msg: Gesture): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return;
  await sendToTab(tab.id, msg).catch(() => undefined);
}

async function clearTabCss(tabId: number): Promise<void> {
  const applied: AppliedMap = (await readParsed("session", APPLIED_KEY, AppliedMap)) ?? {};
  const previous = applied[String(tabId)];
  if (!previous) return;
  await chrome.scripting.removeCSS({ target: { tabId }, css: previous.css }).catch(() => undefined);
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
