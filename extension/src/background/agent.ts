import type { ActiveChange, Change, PageOutline, PageStats } from "../../../shared/adaptation.js";
import type { ApplyOutcome, ClientMessage, RunRequest, ServerMessage, ToolCallMessage, Trigger } from "../../../shared/protocol.js";
import type { AppliedSummary, ContentRequest, ContentResponse, StatusInfo, UiEvent } from "../messages.js";
import { load, recipeKey, save, saveRecipe } from "../storage.js";

interface Run {
  runId: string;
  tabId: number;
  windowId: number;
  origin: string;
  trigger: Trigger;
  message: string;
  applied: Map<string, ActiveChange>;
}

export interface AgentHooks {
  event(tabId: number, event: UiEvent): void;
  tool(tabId: number, name: string, ms: number, ok: boolean, detail: string): void;
  status(status: StatusInfo): void;
}

const STAT_LABELS: Record<keyof PageStats, string> = {
  inputsWithoutLabel: "unlabeled inputs",
  smallTargets: "small targets",
  smallText: "small text",
  lowContrastText: "low-contrast text",
  imagesWithoutAlt: "images without alt",
  runningAnimations: "animations",
  visibleAdsOrPopups: "ads and popups",
};

export async function sendToTab<T>(tabId: number, request: ContentRequest): Promise<T> {
  const response: ContentResponse | undefined = await chrome.tabs.sendMessage(tabId, request);
  if (!response) throw new Error("This page is not reachable. Reload the tab.");
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

export class AgentClient {
  status: StatusInfo = { connected: false, busy: false };
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private runs = new Map<string, Run>();

  constructor(private hooks: AgentHooks) {}

  private setStatus(patch: Partial<StatusInfo>) {
    this.status = { ...this.status, ...patch, busy: this.runs.size > 0 };
    this.hooks.status(this.status);
  }

  ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open() {
    const { serverUrl } = await load();
    await new Promise<void>((resolve, reject) => {
      const unreachable = new Error("Can't reach the agent server. Is `npm run dev` running?");
      const socket = new WebSocket(serverUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(unreachable);
      }, 4000);
      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        this.keepAlive = setInterval(() => this.send({ type: "ping" }), 20_000);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        this.setStatus({ connected: false, error: unreachable.message });
        reject(unreachable);
      };
      socket.onmessage = (event) => void this.onMessage(JSON.parse(event.data) as ServerMessage);
      socket.onclose = () => {
        clearInterval(this.keepAlive);
        this.socket = null;
        for (const run of [...this.runs.values()]) this.fail(run, "Lost connection to the agent server.");
        this.setStatus({ connected: false });
      };
    });
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private emit(run: Run, event: UiEvent) {
    this.hooks.event(run.tabId, event);
  }

  private step(run: Run, text: string, tone: "info" | "good" | "warn" | "bad" = "info") {
    this.emit(run, { type: "step", runId: run.runId, text, tone });
  }

  private fail(run: Run, message: string) {
    this.finish(run);
    this.emit(run, { type: "error", runId: run.runId, message });
  }

  private finish(run: Run) {
    this.runs.delete(run.runId);
    if (run.trigger === "page_load") void sendToTab(run.tabId, { kind: "busy", on: false }).catch(() => undefined);
    this.setStatus({});
  }

  private busyTab(tabId: number) {
    return [...this.runs.values()].some((run) => run.tabId === tabId);
  }

  async startRun(tab: chrome.tabs.Tab, trigger: Trigger, message: string, fresh = false) {
    if (!tab.id || !tab.url?.startsWith("http")) return;
    const tabId = tab.id;
    const origin = new URL(tab.url).origin;
    const runId = crypto.randomUUID();
    const run: Run = { runId, tabId, windowId: tab.windowId, origin, trigger, message, applied: new Map() };

    this.emit(run, { type: "start", runId, trigger, message });
    if (this.busyTab(tabId)) return this.emit(run, { type: "error", runId, message: "Still working on the last request." });

    const state = await load();
    if (state.paused) return this.emit(run, { type: "error", runId, message: "Adaptations are paused. Turn them on in settings." });

    if (trigger === "chat" && !fresh && (await this.tryRecipe(run, state.recipes[recipeKey(origin, message)]?.changes))) return;

    try {
      await this.ensureConnected();
    } catch (error) {
      return this.emit(run, { type: "error", runId, message: error instanceof Error ? error.message : String(error) });
    }

    this.runs.set(runId, run);
    this.setStatus({ connected: true, error: undefined });
    if (trigger === "page_load") await sendToTab(tabId, { kind: "busy", on: true }).catch(() => undefined);

    try {
      const [page, active] = await Promise.all([
        sendToTab<PageOutline>(tabId, { kind: "tool", name: "read_page", input: {} }),
        sendToTab<ActiveChange[]>(tabId, { kind: "list" }),
      ]);
      const request: RunRequest = {
        type: "run",
        runId,
        trigger,
        message,
        routing: state.routing,
        models: state.modelOverrides,
        history: state.history.slice(-8),
        profile: state.profile,
        active,
        page,
      };
      if (trigger === "chat") await save({ history: [...state.history, { role: "user" as const, text: message }].slice(-20) });
      this.send(request);
    } catch (error) {
      this.fail(run, error instanceof Error ? error.message : String(error));
    }
  }

  private async tryRecipe(run: Run, changes: ActiveChange[] | undefined) {
    if (!changes?.length) return false;
    try {
      this.step(run, "Using your saved version of this request", "info");
      for (const change of changes) {
        const outcome = await sendToTab<ApplyOutcome>(run.tabId, { kind: "tool", name: "apply_change", input: { change } });
        if (!outcome.ok) return false;
        run.applied.set(change.id, change);
      }
      this.emit(run, { type: "done", runId: run.runId, trigger: run.trigger, reply: "Done, from your saved version. Hold Shift+Enter to ask the AI again.", applied: this.summaries(run), fromCache: true });
      return true;
    } catch {
      return false;
    }
  }

  private summaries(run: Run): AppliedSummary[] {
    return [...run.applied.values()].map(({ id, summary, reason, scope }) => ({ id, summary, reason, scope }));
  }

  private async onMessage(message: ServerMessage) {
    if (message.type === "hello") {
      this.setStatus({ connected: true, provider: message.provider, models: message.models, available: message.available, error: undefined });
      return;
    }
    if (message.type === "tool") return this.runTool(message);

    const run = this.runs.get(message.runId);
    if (!run) return;
    switch (message.type) {
      case "progress":
        return this.step(run, message.text);
      case "tier":
        return this.emit(run, { type: "tier", runId: run.runId, tier: message.tier, model: message.model });
      case "warning":
        return this.step(run, message.text, "bad");
      case "blocked":
        return this.emit(run, { type: "blocked", runId: run.runId, reason: message.reason });
      case "profile": {
        const state = await load();
        await save({ profile: [...state.profile, ...message.lines.filter((line) => !state.profile.includes(line))] });
        return this.step(run, `Remembered: ${message.lines.join("; ")}`, "good");
      }
      case "error":
        return this.fail(run, message.message);
      case "done":
        return this.complete(run, message.reply);
    }
  }

  private async complete(run: Run, reply: string) {
    const state = await load();
    if (reply) await save({ history: [...state.history, { role: "assistant" as const, text: reply }].slice(-20) });
    if (run.trigger === "chat" && run.applied.size) {
      await saveRecipe(recipeKey(run.origin, run.message), { message: run.message, changes: [...run.applied.values()], at: Date.now() });
    }
    const applied = this.summaries(run);
    if (run.trigger === "page_load" && applied.length) {
      await sendToTab(run.tabId, { kind: "toast", text: `Adapted for you: ${applied.map((change) => change.summary).join(", ")}.`, undoIds: applied.map((change) => change.id) }).catch(() => undefined);
    }
    this.finish(run);
    this.emit(run, { type: "done", runId: run.runId, trigger: run.trigger, reply, applied, fromCache: false });
  }

  private async runTool(message: ToolCallMessage) {
    const run = this.runs.get(message.runId);
    if (!run) return;
    const started = Date.now();
    let result: unknown;
    try {
      if (message.name === "screenshot") {
        if (run.trigger === "page_load") await sendToTab(run.tabId, { kind: "busy", on: false }).catch(() => undefined);
        result = { dataUrl: await captureScaled(run.windowId) };
      } else {
        result = await sendToTab(run.tabId, { kind: "tool", name: message.name, input: message.input });
      }
      if (message.name === "apply_change") this.afterApply(run, (message.input as { change: Change }).change, result as ApplyOutcome);
      this.hooks.tool(run.tabId, message.name, Date.now() - started, true, summarizeInput(message));
      this.send({ type: "toolResult", callId: message.callId, ok: true, result });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.hooks.tool(run.tabId, message.name, Date.now() - started, false, text);
      this.send({ type: "toolResult", callId: message.callId, ok: false, error: text });
    }
  }

  private afterApply(run: Run, change: Change, outcome: ApplyOutcome) {
    if (run.trigger === "page_load") void sendToTab(run.tabId, { kind: "busy", on: false }).catch(() => undefined);
    if (!outcome.ok) return this.step(run, `Couldn't apply "${change.summary}": ${outcome.error}`, "bad");
    run.applied.set(change.id, { ...change, appliedAt: Date.now() });
    const deltas = (Object.keys(STAT_LABELS) as Array<keyof PageStats>)
      .filter((key) => outcome.before[key] !== outcome.after[key])
      .map((key) => `${STAT_LABELS[key]} ${outcome.before[key]} to ${outcome.after[key]}`);
    if (deltas.length) this.step(run, `Verified: ${deltas.join(", ")}`, "good");
    const missed = Object.entries(outcome.matched).filter(([, count]) => count === 0).map(([selector]) => selector);
    if (missed.length) this.step(run, `Matched nothing: ${missed.slice(0, 2).join(", ")}`, "warn");
  }
}

function summarizeInput(message: ToolCallMessage) {
  const input = message.input as { change?: Change; selector?: string };
  return input.change?.summary ?? input.selector ?? "";
}

async function captureScaled(windowId: number): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, 1280 / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
