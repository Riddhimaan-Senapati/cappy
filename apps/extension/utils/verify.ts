import {
  DEFAULT_BACKEND_URL,
  Screenshot,
  VERIFY_PATH,
  VerifyRequest,
  VerifyResponse,
  type Adaptation,
} from "@browser-agent/shared";
import { AxeCount, AxeCountReply, ToContentMessage } from "./messages";
import { VERIFICATION_KEY, Verification } from "./state";
import { next, type Verdict, type VerifyState } from "./verify-machine";

const SETTLE_MS = 400;
const AXE_TIMEOUT_MS = 3000;
const SCREENSHOT_QUALITY = 60;
const ROLLBACK_NOTE = "This change did not help, so the page was restored.";

type Check = { verdict: Verdict; notes: string; axeAfter: number; after: string | undefined };

export function judgeByIssues(axeBefore: number, axeAfter: number): Verdict {
  if (axeAfter < axeBefore) return "improved";
  if (axeAfter > axeBefore) return "worse";
  return "no_change";
}

/**
 * Applies the adaptation through `applyFn` (which returns false if it could not
 * be applied and has already reported that) and checks the result. A bad first
 * verdict triggers one undo and re-apply; a bad second verdict undoes it for good.
 */
export async function verifyAdaptation(
  tabId: number,
  adaptation: Adaptation,
  applyFn: () => Promise<boolean>,
  undoFn: () => Promise<void>,
): Promise<void> {
  // Must be captured before the change lands, or the "before" shot shows the change.
  const before = await captureShot(tabId);
  const axeBefore = (await axeCount(tabId)) ?? 0;

  const record: Verification = { adaptationId: adaptation.id, state: "proposed", axeBefore, before };
  const commit = async (s: VerifyState, patch: Partial<Verification> = {}) => {
    Object.assign(record, patch);
    record.state = s.tag;
    record.attempt = "attempt" in s ? s.attempt : undefined;
    await chrome.storage.session.set({ [VERIFICATION_KEY]: Verification.parse(record) });
  };

  let s: VerifyState = { tag: "proposed" };
  await commit(s);
  if (!(await applyFn())) return;
  s = next(s, { type: "applied" });
  s = next(s, { type: "verify_started" });
  await commit(s);

  let result = await check(tabId, adaptation, before, axeBefore);
  for (;;) {
    s = next(s, { type: "verdict", verdict: result.verdict });
    await commit(s, { verdict: result.verdict, notes: result.notes, axeAfter: result.axeAfter, after: result.after });
    if (s.tag === "verified") return;

    await undoFn();
    if (s.tag === "retrying" && (await applyFn())) {
      s = next(next(s, { type: "retry_done" }), { type: "verify_started" });
      await commit(s);
      result = await check(tabId, adaptation, before, axeBefore);
      continue;
    }

    s = next(s, { type: "rollback_done" });
    await commit(s);
    await chrome.tabs.sendMessage(tabId, ToContentMessage.parse({ type: "banner-note", text: ROLLBACK_NOTE })).catch(
      () => undefined,
    );
    return;
  }
}

async function check(
  tabId: number,
  adaptation: Adaptation,
  before: string | undefined,
  axeBefore: number,
): Promise<Check> {
  await sleep(SETTLE_MS);
  const after = await captureShot(tabId);
  const axeAfter = (await axeCount(tabId)) ?? 0;

  if (before && after) {
    const req = VerifyRequest.safeParse({ adaptation, before, after, axeBefore, axeAfter });
    if (req.success) {
      const remote = await judgeRemote(req.data);
      if (remote) return { verdict: remote.verdict, notes: remote.notes, axeAfter, after };
    }
  }
  return {
    verdict: judgeByIssues(axeBefore, axeAfter),
    notes: `Judged by issue count (${axeBefore} to ${axeAfter}); the visual check was unavailable.`,
    axeAfter,
    after,
  };
}

async function judgeRemote(req: VerifyRequest): Promise<VerifyResponse | undefined> {
  try {
    const res = await fetch(`${DEFAULT_BACKEND_URL}${VERIFY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return undefined;
    const parsed = VerifyResponse.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch (err) {
    console.warn("verify request failed", err);
    return undefined;
  }
}

async function captureShot(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    // captureVisibleTab only sees the active tab of a window, so a background tab would capture the wrong page.
    if (!tab.active || tab.windowId === undefined) return undefined;
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: SCREENSHOT_QUALITY });
    const parsed = Screenshot.safeParse(url);
    return parsed.success ? parsed.data : undefined;
  } catch (err) {
    console.warn("screenshot failed", err);
    return undefined;
  }
}

async function axeCount(tabId: number): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), AXE_TIMEOUT_MS);
  });
  const reply = chrome.tabs
    .sendMessage(tabId, AxeCount.parse({ type: "axe-count" }))
    .then((raw: unknown) => {
      const parsed = AxeCountReply.safeParse(raw);
      return parsed.success ? parsed.data.count : undefined;
    })
    .catch(() => undefined);
  try {
    return await Promise.race([reply, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
