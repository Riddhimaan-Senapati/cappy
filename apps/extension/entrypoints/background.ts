import {
  AdaptRequest,
  AdaptResponse,
  ADAPT_PATH,
  DEFAULT_BACKEND_URL,
  NeedId,
  RequestBody,
  matchesHost,
  ruleAppliesTo,
  type Adaptation,
  type AdaptationId,
  type ContentFilter,
  type Profile,
  type Rule,
} from "@browser-agent/shared";
import { colorFilterSvg, compileAdaptationCss } from "@browser-agent/blocks";
import {
  ApplyFiltersReply,
  Gesture,
  Message,
  PageReady,
  ToContentMessage,
  type OutlineReply,
} from "../utils/messages";
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
import { describeChoice, logForTab, startRun } from "../utils/steps";
import { hasRuntimeBlock } from "../utils/runtime-blocks";
import { clientTime, loadClock, now } from "../utils/clock";
import { RULES_KEY, addRulesFromAdaptation, loadRules, parseRules, rulesForHost, saveRules } from "../utils/rules";

const APPLIED_KEY = KEYS.applied;
const RULES_BY_ADAPTATION = "rulesByAdaptation";
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "paused" in changes) void applyPause(changes.paused?.newValue === true);
    if (area !== "local" || !(RULES_KEY in changes)) return;
    const change = changes[RULES_KEY];
    void resendRules(parseRules(change?.oldValue), parseRules(change?.newValue));
  });

  startFriction(promptFriction);
});

async function handlePageReady(tabId: number, msg: PageReady): Promise<void> {
  await loadClock();
  await forgetApplied(tabId);
  const { paused, proactive } = await chrome.storage.local.get(["paused", "proactive"]);
  if (paused === true) return notifyDone(tabId);
  await applyRulesToTab(tabId, msg.url);
  const profile = await loadProfile();
  if (profile.needs.length === 0) return notifyDone(tabId);

  const host = hostOf(msg.url);
  await startRun(tabId);
  await logForTab(tabId, "info", `Reading ${host ?? "this page"}…`);
  const saved = host ? lookup(await readSaved(), host, profile.version) : undefined;
  if (saved) {
    await logForTab(tabId, "good", "Restored saved change, no model call");
    const restored = await applyResponse(tabId, msg.url, { kind: "adaptation", adaptation: saved }, profile, {
      restored: true,
    });
    if (restored) return;
  }

  if (proactive === false) {
    await logForTab(tabId, "info", "Act on page load is off, so no model call");
    return notifyDone(tabId);
  }

  const request = AdaptRequest.safeParse({ url: msg.url, outline: msg.outline, profile, clientTime: clientTime() });
  if (!request.success) {
    await setLast({ status: "error", url: msg.url, message: "Page details were not valid" });
    return notifyDone(tabId);
  }

  let raw: unknown;
  await logForTab(tabId, "info", "Asked the model for a change");
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
    await logForTab(tabId, "bad", "Stopped: backend unreachable");
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
    await logForTab(tabId, "warn", `Nothing to change: ${response.reason}`);
    await setLast({ status: "none", url, reason: response.reason });
    return false;
  }
  if (response.kind === "blocked") {
    await logForTab(tabId, "bad", "Blocked: page tried to give the agent instructions");
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
  const hasFilters = (adaptation.filters?.length ?? 0) > 0;
  if (!css.trim() && !svg && !adaptation.ops?.length && !hasFilters && !hasRuntimeBlock(adaptation.blocks)) {
    await logForTab(tabId, "warn", "Nothing to change: the model proposed no page edits");
    await setLast({ status: "none", url, reason: "Nothing to change on this page" });
    return false;
  }

  if (!restored) await logForTab(tabId, "info", `Model chose: ${describeChoice(adaptation)}`);
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
    if (hasRuntimeBlock(adaptation.blocks)) {
      await sendToTab(tabId, { type: "apply-runtime", adaptationId: adaptation.id, blocks: adaptation.blocks }).catch(
        (err: unknown) => console.warn("runtime blocks failed to apply", err),
      );
    }
    if (adaptation.ops?.length) {
      await sendToTab(tabId, { type: "apply-ops", adaptationId: adaptation.id, ops: adaptation.ops }).catch(
        (err: unknown) => console.warn("element ops failed to apply", err),
      );
    }
    if (adaptation.filters?.length) await applyFilters(tabId, adaptation.id, adaptation.filters);
    await setLast({
      status: "applied",
      url,
      tabId,
      adaptationId: adaptation.id,
      reason,
      blocks: adaptation.blocks.map((b) => b.block),
      restored,
    });
    await logForTab(tabId, "good", `Applied: ${reason}`);
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
  await loadClock();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) {
    await setLast({ status: "error", url: "", message: "No active tab to change" });
    return;
  }
  const tabId = tab.id;
  await startRun(tabId);
  const reply = await requestOutline(tabId);
  if (!reply) {
    await logForTab(tabId, "bad", "Stopped: this page cannot be read");
    await setLast({
      status: "error",
      url: tab.url ?? "",
      message: "This page cannot be read. Open a normal web page and try again.",
    });
    return;
  }

  await logForTab(tabId, "info", `Reading ${hostOf(reply.url) ?? "this page"}…`);
  const profile = await loadProfile();
  const body = RequestBody.parse({ ...buildRequestBody(reply, profile, text), clientTime: clientTime() });
  let raw: unknown;
  await logForTab(tabId, "info", "Asked the model for a change");
  try {
    raw = await postRequest(body);
  } catch (err) {
    console.warn("request failed", err);
    await logForTab(tabId, "bad", "Stopped: backend unreachable");
    await setLast({ status: "error", url: reply.url, message: "Backend unreachable" });
    return;
  }
  const parsed = AdaptResponse.safeParse(raw);
  if (!parsed.success) {
    await setLast({ status: "error", url: reply.url, message: "Backend sent an unexpected response" });
    return;
  }
  const applied = await applyResponse(tabId, reply.url, parsed.data, profile);
  if (applied && parsed.data.kind === "adaptation" && (parsed.data.adaptation.filters?.length ?? 0) > 0) {
    await rememberRules(reply.url, parsed.data.adaptation, text);
  }
}

async function rememberRules(url: string, adaptation: Adaptation, text: string): Promise<void> {
  const host = hostOf(url);
  if (!host) return;
  const before = await loadRules();
  const next = addRulesFromAdaptation(before, adaptation, host, text, now());
  await saveRules(next).catch((err: unknown) => console.warn("could not save rules", err));
  const known = new Set(before.map((r) => r.id));
  const created = next.filter((r) => !known.has(r.id)).map((r) => r.id);
  if (created.length === 0) return;
  const stored = await chrome.storage.session.get(RULES_BY_ADAPTATION);
  const map = { ...(stored[RULES_BY_ADAPTATION] as Record<string, string[]> | undefined), [adaptation.id]: created };
  await chrome.storage.session.set({ [RULES_BY_ADAPTATION]: map });
}

// Undoing a change the user just asked for also deletes the standing rules that change created.
async function forgetRulesFrom(adaptationId: string): Promise<void> {
  const stored = await chrome.storage.session.get(RULES_BY_ADAPTATION);
  const map = (stored[RULES_BY_ADAPTATION] as Record<string, string[]> | undefined) ?? {};
  const ids = new Set(map[adaptationId] ?? []);
  if (ids.size === 0) return;
  await saveRules((await loadRules()).filter((r) => !ids.has(r.id)));
  delete map[adaptationId];
  await chrome.storage.session.set({ [RULES_BY_ADAPTATION]: map });
}

async function applyRulesToTab(tabId: number, url: string): Promise<void> {
  const host = hostOf(url);
  if (!host) return;
  const rules = rulesForHost(await loadRules(), host);
  await sendToTab(tabId, { type: "apply-rules", rules }).catch(() => undefined);
}

// The kill switch clears every rule filter and page change in open tabs; turning it back on restores the rules.
async function applyPause(paused: boolean): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const rules = paused ? [] : await loadRules();
  for (const tab of tabs) {
    const host = hostOf(tab.url);
    if (tab.id === undefined || !host) continue;
    await sendToTab(tab.id, { type: "apply-rules", rules: rulesForHost(rules, host) }).catch(() => undefined);
    if (paused) await sendToTab(tab.id, { type: "remove-banner" }).catch(() => undefined);
  }
}

// Tabs are re-sent their rules when rules change, including tabs whose host lost its last rule
// so that the removed filter stops applying there.
async function resendRules(previous: Rule[], next: Rule[]): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    const host = hostOf(tab.url);
    if (tab.id === undefined || !host) continue;
    const affected = previous.some((r) => ruleAppliesTo(r, host)) || next.some((r) => ruleAppliesTo(r, host));
    if (!affected) continue;
    await sendToTab(tab.id, { type: "apply-rules", rules: rulesForHost(next, host) }).catch(() => undefined);
  }
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
  await forgetRulesFrom(adaptationId).catch((err: unknown) => console.warn("could not remove rules", err));

  await chrome.scripting.removeCSS({ target: { tabId }, css }).catch((err: unknown) => {
    console.warn("removeCSS failed, tab may be gone", err);
  });
  await sendToTab(tabId, { type: "remove-banner" }).catch(() => undefined);
  await sendToTab(tabId, { type: "undo-runtime" }).catch(() => undefined);
  await forgetApplied(tabId);
  await logForTab(tabId, "info", "Undone by you");

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

async function applyFilters(tabId: number, adaptationId: AdaptationId, filters: ContentFilter[]): Promise<void> {
  const raw: unknown = await chrome.tabs
    .sendMessage(tabId, ToContentMessage.parse({ type: "apply-filters", adaptationId, filters }))
    .catch((err: unknown) => {
      console.warn("filters failed to apply", err);
      return undefined;
    });
  const reply = ApplyFiltersReply.safeParse(raw);
  if (!reply.success) return;
  const matched = reply.data.matched;
  if (matched === 0) {
    await logForTab(tabId, "warn", "Filter matched nothing");
    return;
  }
  const verb = filters.every((f) => f.action === "hide") ? "hid" : "changed";
  const keywords = filters.flatMap((f) => f.keywords).slice(0, 3).join(", ");
  await logForTab(tabId, "good", `Filter ${verb} ${matched} item${matched === 1 ? "" : "s"} matching ${keywords}`);
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
