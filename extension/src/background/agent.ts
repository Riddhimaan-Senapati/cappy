import { LARGER_TEXT } from "../zoom-preference.js";
import { hasMemoryLine, profileFor, rememberLines } from "../memory.js";
import type { ActiveChange, Change, PageOutline, PageStats } from "../../../shared/adaptation.js";
import type { ApplyOutcome, ClientMessage, FrictionCount, ProviderInfo, RunRequest, ServerMessage, SiteControlOutcome, Suggestion, TargetElement, ToolCallMessage, Trigger } from "../../../shared/protocol.js";
import type { AppliedSummary, ContentRequest, ContentResponse, StatusInfo, UiEvent } from "../messages.js";
import { recentFeedback } from "../feedback.js";
import { emptyActivity, summarizeActivity } from "../friction-log.js";
import { findRequestSessions, load, recipeKey, save, saveRecipe, saveSiteNotes } from "../storage.js";
import { speakIfEnabled } from "./tts.js";
import { detectInjection } from "../../../shared/safety.js";
import { changesWithDarkModeLast, scheduleStatus } from "../../../shared/validate.js";
import { settle } from "../coalesce.js";
import { paintedStatusKey } from "../status-key.js";

interface Run {
  runId: string;
  tabId: number;
  windowId: number;
  origin: string;
  trigger: Trigger;
  message: string;
  applied: Map<string, ActiveChange>;
  siteControls: Map<string, ActiveChange>;
  commandId?: string;
  thread?: string;
  target?: TargetElement;
  documentId?: string;
  // Set when the run request is sent, so a replaced socket can still fail its own runs.
  socket?: WebSocket;
}

export interface AgentHooks {
  event(tabId: number, event: UiEvent): void;
  tool(tabId: number, name: string, ms: number, ok: boolean, detail: string): void;
  status(status: StatusInfo): void;
}

const SERVER_OFFLINE = new Error("The local Cappy server is offline. Start it to send a new AI request.");
class ReplacedDial extends Error {
  constructor() {
    super("The server address changed.");
  }
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

export class PageChangedError extends Error {}

// A run that outlives a navigation must not reach the page that replaced the one the user asked about.
export async function sendToTab<T>(tabId: number, request: ContentRequest, documentId?: string): Promise<T> {
  let response: ContentResponse | undefined;
  try {
    response = await chrome.tabs.sendMessage(tabId, request, documentId ? { documentId } : {});
  } catch (error) {
    // Chrome words a gone document like any unreachable page, so ask the tab which document it has now.
    if (documentId && (await documentIdOf(tabId)) !== documentId) throw new PageChangedError("The page changed, so this request was stopped.");
    throw error;
  }
  if (!response) throw new Error("This page is not reachable. Reload the tab.");
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

interface StartOptions {
  fresh?: boolean;
  interrupt?: boolean;
  queuedId?: string;
  // A caller that waits for this run's result (a GPT-Live task) picks the id; it stays the same if the run is queued.
  runId?: string;
  commandId?: string;
  thread?: string;
  target?: TargetElement;
  claimKey?: string;
}

export class AgentClient {
  status: StatusInfo = { connected: false, busy: false };
  private usageUpdates = Promise.resolve();
  private socket: WebSocket | null = null;
  private connectedUrl: string | null = null;
  private opening: Promise<void> | null = null;
  private connectGeneration = 0;
  private nextConnectAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retrying = false;
  private paintedKey = "";
  private statusWrite: Promise<void> = Promise.resolve();
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private runs = new Map<string, Run>();
  private providers: ProviderInfo[] = [];
  private defaultProvider: string | null = null;
  private notice: StatusInfo["notice"];
  private modelsRequested = new Set<string>();
  private suggestionTabs = new Map<string, number>();
  private suggestions = new Map<string, (suggestion: Suggestion | null) => void>();
  private classifications = new Map<string, (verdicts: boolean[] | null) => void>();
  private queues = new Map<number, Array<{ runId: string; message: string; fresh: boolean; commandId?: string; thread?: string; target?: TargetElement; origin: string }>>();
  // command id + origin, claimed before the run is stored, so two tabs cannot both start it.
  private commandClaims = new Set<string>();

  constructor(private hooks: AgentHooks) {}

  private setStatus(patch: Partial<StatusInfo>) {
    this.status = { ...this.status, ...patch, busy: this.runs.size > 0 };
    this.statusWrite = this.statusWrite.then(() => this.publishStatus()).catch(() => undefined);
  }

  private async publishStatus() {
    const status = await settle(this.getStatus(), undefined, 8_000);
    if (!status) return;
    this.hooks.status(status);
    const key = paintedStatusKey(status);
    // Settings repaints on storage changes. An unchanged painted status must not stamp, or every paint probes the server again.
    if (key === this.paintedKey) return;
    this.paintedKey = key;
    await chrome.storage.local.set({ statusStamp: Date.now() });
  }

  async getStatus(): Promise<StatusInfo> {
    const state = await load();
    const ready = this.providers.filter((provider) => provider.ready);
    const active = ready.find((provider) => provider.id === state.provider) ?? ready.find((provider) => provider.id === this.defaultProvider) ?? ready[0];
    return {
      ...this.status,
      providers: this.providers,
      activeProvider: active?.id ?? null,
      provider: active?.label,
      models: active?.models,
      available: active?.available,
      notice: this.notice,
    };
  }

  async ensureModels() {
    const { activeProvider } = await this.getStatus();
    const active = this.providers.find((provider) => provider.id === activeProvider);
    if (!active?.ready || active.available || this.modelsRequested.has(active.id)) return;
    this.modelsRequested.add(active.id);
    this.send({ type: "listModels", provider: active.id });
  }

  async suggest(page: PageOutline, applied: string[], friction?: FrictionCount[], tabId?: number): Promise<Suggestion | null> {
    try {
      await this.ensureConnected();
    } catch {
      return null;
    }
    const state = await load();
    const { activeProvider } = await this.getStatus();
    if (!activeProvider) return null;
    const requestId = crypto.randomUUID();
    const feedback = await recentFeedback();
    if (tabId) this.suggestionTabs.set(requestId, tabId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.suggestions.delete(requestId);
        this.suggestionTabs.delete(requestId);
        resolve(null);
      }, 12_000);
      this.suggestions.set(requestId, (suggestion) => {
        clearTimeout(timer);
        resolve(suggestion);
      });
      const host = (() => { try { return new URL(page.url).host; } catch { return ""; } })();
      this.send({ type: "suggest", requestId, provider: activeProvider, models: state.modelChoices[activeProvider] ?? {}, profile: profileFor(state.profile, host), applied, page, host, friction, feedback });
    });
  }

  async classify(match: string, items: string[]): Promise<boolean[] | null> {
    try {
      await this.ensureConnected();
    } catch {
      return null;
    }
    const state = await load();
    const { activeProvider } = await this.getStatus();
    if (!activeProvider) return null;
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.classifications.delete(requestId);
        resolve(null);
      }, 20_000);
      this.classifications.set(requestId, (verdicts) => {
        clearTimeout(timer);
        resolve(verdicts);
      });
      this.send({ type: "classify", requestId, provider: activeProvider, models: state.modelChoices[activeProvider] ?? {}, match, items });
    });
  }

  async setKey(provider: string, key: string | null, baseURL?: string | null) {
    await this.ensureConnected();
    this.send({ type: "setKey", provider, key, ...(baseURL != null ? { baseURL } : {}) });
  }

  async signOut() {
    await this.ensureConnected();
    this.modelsRequested.delete("chatgpt-signin");
    this.send({ type: "chatgptLogout" });
  }

  async signIn() {
    await this.ensureConnected();
    this.send({ type: "chatgptLogin" });
  }

  // Drop a socket that was opened against the previous address and dial the new one.
  useServer(url: string) {
    if (this.connectedUrl === url && this.socket?.readyState === WebSocket.OPEN) return;
    this.nextConnectAt = 0;
    this.clearReconnect();
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    // The in-flight dial is still the old address. Drop it so ensureConnected opens a new one.
    this.connectGeneration++;
    this.opening = null;
    const previous = this.socket;
    this.socket = null;
    this.connectedUrl = null;
    previous?.close();
    void this.ensureConnected().catch(() => undefined);
  }

  // Every caller follows a server change. A dial that lost the race rejects and the next attempt uses the new address.
  async ensureConnected(options?: { probe?: boolean }): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const generation = this.connectGeneration;
      try {
        await this.dial(options);
        return;
      } catch (error) {
        if (this.connectGeneration === generation && !(error instanceof ReplacedDial)) throw error;
      }
    }
    throw SERVER_OFFLINE;
  }

  private dial(options?: { probe?: boolean }): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (options?.probe && Date.now() < this.nextConnectAt) {
      this.scheduleReconnect();
      return Promise.reject(SERVER_OFFLINE);
    }
    if (!this.opening) {
      const generation = this.connectGeneration;
      this.opening = this.open(generation).finally(() => {
        if (this.connectGeneration === generation) this.opening = null;
      });
    }
    return this.opening;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined) return;
    const wait = Math.max(0, this.nextConnectAt - Date.now());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.retrying = true;
      void this.ensureConnected()
        .then(
          () => this.setStatus({ connected: true, error: undefined }),
          () => undefined,
        )
        .finally(() => {
          this.retrying = false;
        });
    }, wait);
  }

  private clearReconnect() {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async open(generation: number) {
    const { serverUrl } = await load();
    if (generation !== this.connectGeneration) throw SERVER_OFFLINE;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(serverUrl);
      let opened = false;
      const stale = () => generation !== this.connectGeneration;
      const rejectOffline = () => {
        if (stale()) {
          reject(new ReplacedDial());
          return;
        }
        this.nextConnectAt = Date.now() + 4000;
        // One retry per failure; a failed retry waits for the next status probe instead of looping forever.
        if (!this.retrying) this.scheduleReconnect();
        reject(SERVER_OFFLINE);
      };
      const timer = setTimeout(() => {
        socket.close();
        rejectOffline();
      }, 4000);
      socket.onopen = () => {
        clearTimeout(timer);
        if (stale()) {
          opened = true;
          socket.close();
          reject(new ReplacedDial());
          return;
        }
        opened = true;
        this.nextConnectAt = 0;
        this.clearReconnect();
        clearInterval(this.keepAlive);
        this.socket = socket;
        this.connectedUrl = serverUrl;
        this.keepAlive = setInterval(() => this.send({ type: "ping" }), 20_000);
        resolve();
      };
      socket.onerror = () => {
        // A socket that already opened reports the drop through onclose. A failed handshake rejects now.
        if (opened) return;
        clearTimeout(timer);
        this.setStatus({ connected: false, error: SERVER_OFFLINE.message });
        rejectOffline();
      };
      socket.onmessage = (event) => void this.onMessage(JSON.parse(event.data) as ServerMessage);
      socket.onclose = () => {
        for (const run of [...this.runs.values()]) {
          if (run.socket === socket) this.fail(run, "Lost connection to the Cappy server.");
        }
        // Only the live socket owns the connection. Runs sent on a replaced socket were failed above.
        if (this.socket !== socket) return;
        clearInterval(this.keepAlive);
        this.socket = null;
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
    if (run.commandId) this.commandClaims.delete(this.commandKey(run.commandId, run.origin));
    this.finish(run);
    this.emit(run, { type: "error", runId: run.runId, message });
  }

  private finish(run: Run, succeeded = false) {
    if (!this.runs.delete(run.runId)) return;
    if (run.trigger === "page_load") void sendToTab(run.tabId, { kind: "busy", on: false }).catch(() => undefined);
    this.setStatus({});
    if (succeeded) void this.next(run.tabId);
  }

  // Stopping keeps queued requests and already-applied changes in place.
  stopRun(tabId: number) {
    for (const run of [...this.runs.values()].filter((existing) => existing.tabId === tabId)) this.cancelRun(run, "Stopped.");
  }

  stopForProfileSwitch() {
    for (const [tabId, queue] of this.queues) {
      for (const item of queue) {
        if (item.commandId) this.commandClaims.delete(this.commandKey(item.commandId, item.origin));
        this.hooks.event(tabId, { type: "cancelled", runId: item.runId, reason: "Profile switched." });
      }
    }
    this.queues.clear();
    for (const run of [...this.runs.values()]) this.cancelRun(run, "Profile switched.");
  }

  private cancelRun(run: Run, reason: string) {
    if (run.commandId) this.commandClaims.delete(this.commandKey(run.commandId, run.origin));
    this.send({ type: "cancel", runId: run.runId });
    this.finish(run);
    this.emit(run, { type: "cancelled", runId: run.runId, reason });
  }

  dequeue(tabId: number, runId: string) {
    const queue = this.queues.get(tabId) ?? [];
    const dropped = queue.find((item) => item.runId === runId);
    this.queues.set(tabId, queue.filter((item) => item.runId !== runId));
    if (dropped?.commandId) this.commandClaims.delete(this.commandKey(dropped.commandId, dropped.origin));
    this.hooks.event(tabId, { type: "cancelled", runId });
  }

  private async next(tabId: number) {
    if ([...this.runs.values()].some((run) => run.tabId === tabId)) return;
    const item = this.queues.get(tabId)?.shift();
    if (!item) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return void this.queues.delete(tabId);
    await this.startRun(tab, "chat", item.message, { fresh: item.fresh, queuedId: item.runId, commandId: item.commandId, thread: item.thread, target: item.target });
  }

  // A busy tab queues new requests; interrupt cancels the active run instead. The queue drains only after a successful reply.
  async startRun(tab: chrome.tabs.Tab, trigger: Trigger, message: string, options: StartOptions = {}): Promise<"started" | "queued" | false> {
    if (!tab.id || !tab.url?.startsWith("http")) return false;
    const { fresh = false, interrupt = false, queuedId, commandId, thread, target, claimKey } = options;
    const tabId = tab.id;
    const origin = new URL(tab.url).origin;
    const host = new URL(tab.url).host;
    const runId = queuedId ?? options.runId ?? crypto.randomUUID();
    const run: Run = { runId, tabId, windowId: tab.windowId, origin, trigger, message, applied: new Map(), siteControls: new Map(), commandId, thread, target };

    const active = [...this.runs.values()].filter((existing) => existing.tabId === tabId);
    if (active.length && trigger === "page_load") return false;
    if (active.length && interrupt) for (const existing of active) this.cancelRun(existing, "Interrupted by a new request.");
    else if (active.length && !queuedId) {
      this.queues.set(tabId, [...(this.queues.get(tabId) ?? []), { runId, message, fresh, commandId, thread, target, origin }]);
      this.emit(run, { type: "queued", runId, message, thread });
      return "queued";
    }
    this.emit(run, { type: "start", runId, trigger, message, thread, ...(claimKey ? { claimKey } : {}) });
    this.runs.set(runId, run);
    this.setStatus({});

    const state = await load();
    if (!this.runs.has(runId)) return false;
    if (state.paused) {
      this.fail(run, "Adaptations are paused. Turn them on in settings.");
      return false;
    }

    if (trigger === "chat" && !thread && !fresh && !target) {
      const recipe = await this.tryRecipe(run, state.recipes[recipeKey(origin, message)]?.changes);
      if (recipe === "applied") {
        await this.markCommandApplied(run);
        return "started";
      }
      if (recipe === "blocked" || recipe === "stopped") return false;
    }
    if (!this.runs.has(runId)) return false;

    try {
      await this.ensureConnected();
    } catch (error) {
      if (this.runs.has(runId)) this.fail(run, error instanceof Error ? error.message : String(error));
      return false;
    }

    if (!this.runs.has(runId)) return false;
    this.setStatus({ connected: true, error: undefined });
    if (trigger === "page_load") await sendToTab(tabId, { kind: "busy", on: true }).catch(() => undefined);

    try {
      run.documentId = await documentIdOf(tabId);
      const [page, active] = await Promise.all([
        sendToTab<PageOutline>(tabId, { kind: "tool", name: "read_page", input: {} }, run.documentId),
        sendToTab<ActiveChange[]>(tabId, { kind: "list" }, run.documentId),
      ]);
      const request: RunRequest = {
        type: "run",
        runId,
        trigger,
        message,
        provider: (await this.getStatus()).activeProvider ?? undefined,
        target,
        routing: state.routing,
        models: state.modelChoices[(await this.getStatus()).activeProvider ?? ""] ?? {},
        history: thread
          ? findRequestSessions(state, thread).filter(({ outcome }) => outcome === "done").slice(-4).flatMap(({ message, reply }) => [
              { role: "user", text: message }, { role: "assistant", text: reply },
            ])
          : state.history.slice(-8),
        profile: profileFor(trigger === "page_load" ? state.profile.filter((line) => !hasMemoryLine([line], LARGER_TEXT)) : state.profile, host),
        siteSkill: state.siteSkills[host]?.notes,
        activity: summarizeActivity(state.activity ?? emptyActivity(), host, Date.now()),
        active,
        page,
        clientTime: localClock(),
      };
      const historyText = target ? `${message} (selected: ${target.label})` : message;
      if (trigger === "chat") await save({ history: [...state.history, { role: "user" as const, text: historyText }].slice(-20) });
      if (!this.runs.has(runId)) return false;
      run.socket = this.socket ?? undefined;
      this.send(request);
      return "started";
    } catch (error) {
      if (this.runs.has(runId)) this.fail(run, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async tryRecipe(run: Run, changes: ActiveChange[] | undefined): Promise<"applied" | "blocked" | "stopped" | false> {
    if (!changes?.length) return false;
    try {
      const page = await sendToTab<PageOutline>(run.tabId, { kind: "tool", name: "read_page", input: {} }, run.documentId);
      if (!this.runs.has(run.runId)) return "stopped";
      // Same check the server runs before a model call, so a saved change cannot land on a trap page.
      const injection = detectInjection(page);
      if (injection) {
        const reply = "This page contains text that tries to instruct me, so I didn't change anything.";
        void speakIfEnabled(reply, run.tabId);
        this.finish(run, true);
        this.emit(run, { type: "blocked", runId: run.runId, reason: injection });
        this.emit(run, { type: "done", runId: run.runId, trigger: run.trigger, reply, applied: [], fromCache: true });
        return "blocked";
      }
      this.step(run, "Using your saved version of this request", "info");
      let appliedAny = false;
      for (const change of changesWithDarkModeLast(changes)) {
        if (!this.runs.has(run.runId)) return "stopped";
        const outcome = await sendToTab<ApplyOutcome>(run.tabId, { kind: "tool", name: "apply_change", input: { change }, source: "recipe" }, run.documentId);
        if (!outcome.ok) return false;
        if (outcome.noop) continue;
        run.applied.set(change.id, change);
        appliedAny = true;
      }
      if (!appliedAny) return false;
      if (!this.runs.has(run.runId)) return "stopped";
      this.finish(run, true);
      const reply = "Done, from your saved version. Hold Shift+Enter to ask the AI again.";
      void speakIfEnabled(reply, run.tabId);
      this.emit(run, { type: "done", runId: run.runId, trigger: run.trigger, reply, applied: this.summaries(run), fromCache: true });
      return "applied";
    } catch {
      return false;
    }
  }

  private async markCommandApplied(run: Run) {
    if (!run.commandId) return;
    const { commands } = await load();
    await save({ commands: commands.map((command) => (command.id === run.commandId && !command.appliedOrigins.includes(run.origin) ? { ...command, appliedOrigins: [...command.appliedOrigins, run.origin] } : command)) });
  }

  private commandKey(commandId: string, origin: string) {
    return `${commandId}\n${origin}`;
  }

  // Commands set to run on every site run once per new site; undoing one on a site keeps it from coming back there.
  async runEverywhereCommands(tab: chrome.tabs.Tab, origin: string) {
    const { commands, paused } = await load();
    if (paused || !tab.id) return;
    const due = [];
    for (const command of commands) {
      if (!command.everywhere || command.appliedOrigins.includes(origin)) continue;
      const key = this.commandKey(command.id, origin);
      if (this.commandClaims.has(key)) continue;
      this.commandClaims.add(key);
      due.push(command);
    }
    for (const command of due) {
      const result = await this.startRun(tab, "chat", command.prompt, { commandId: command.id });
      if (result !== "started" && result !== "queued") this.commandClaims.delete(this.commandKey(command.id, origin));
    }
  }

  private summaries(run: Run): AppliedSummary[] {
    return [...run.applied.values(), ...run.siteControls.values()].map(({ id, summary, reason, scope, schedule }) => ({ id, summary, reason, scope, ...(schedule ? { schedule: scheduleStatus(schedule) ?? undefined } : {}) }));
  }

  private async onMessage(message: ServerMessage) {
    if (message.type === "usage") {
      const run = message.runId ? this.runs.get(message.runId) : undefined;
      if (run) this.emit(run, { type: "usage", runId: run.runId, usage: message.usage });
      const tabId = run?.tabId ?? (message.requestId ? this.suggestionTabs.get(message.requestId) : undefined);
      if (tabId) void sendToTab(tabId, { kind: "usage", usage: message.usage, model: message.model, purpose: run ? (run.trigger === "page_load" ? "Automatic page adaptation" : "Chat adaptation") : "Page suggestion" }).catch(() => undefined);
      this.usageUpdates = this.usageUpdates.then(async () => {
        const { usage } = await load();
        await save({ usage: {
          calls: usage.calls + message.usage.calls,
          inputTokens: usage.inputTokens + message.usage.inputTokens,
          outputTokens: usage.outputTokens + message.usage.outputTokens,
        } });
      });
      return;
    }
    if (message.type === "providers") {
      this.providers = message.providers;
      this.defaultProvider = message.defaultProvider;
      if (this.notice?.level === "info") this.notice = undefined;
      this.setStatus({ connected: true, error: undefined });
      void this.ensureModels();
      return;
    }
    if (message.type === "classified") {
      this.classifications.get(message.requestId)?.(message.verdicts);
      this.classifications.delete(message.requestId);
      return;
    }
    if (message.type === "suggestion") {
      this.suggestions.get(message.requestId)?.(message.suggestion);
      this.suggestions.delete(message.requestId);
      this.suggestionTabs.delete(message.requestId);
      return;
    }
    if (message.type === "notice") {
      this.notice = { level: message.level, text: message.text };
      this.setStatus({});
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
      case "options":
        return this.emit(run, { type: "options", runId: run.runId, question: message.question, options: message.options });
      case "profile": {
        const host = new URL(run.origin).host;
        const proposed = await rememberLines(message.lines, { host, scope: message.scope === "site" ? "site" : "everywhere" });
        if (proposed.length) this.emit(run, { type: "memory", runId: run.runId, status: "proposed", lines: proposed, host, scope: message.scope });
        return;
      }
      case "siteSkill":
        if (Array.isArray(message.notes)) await saveSiteNotes(new URL(run.origin).host, message.notes.filter((note) => typeof note === "string").map((note) => note.slice(0, 200)).slice(0, 6));
        return;
      case "error":
        return this.fail(run, message.message);
      case "done":
        return this.complete(run, message.reply);
    }
  }

  private async complete(run: Run, reply: string) {
    const state = await load();
    if (reply) await save({ history: [...state.history, { role: "assistant" as const, text: reply }].slice(-20) });
    if (run.trigger === "chat" && run.applied.size && !run.target) {
      await saveRecipe(recipeKey(run.origin, run.message), { message: run.message, changes: [...run.applied.values()], at: Date.now() });
    }
    const applied = this.summaries(run);
    if (run.trigger === "chat") void speakIfEnabled(reply, run.tabId);
    if (applied.length) await this.markCommandApplied(run);
    if (run.trigger === "page_load" && applied.length) {
      const announcement = `Adapted for you: ${applied.map((change) => change.summary).join(", ")}.`;
      void speakIfEnabled(announcement, run.tabId);
      await sendToTab(run.tabId, { kind: "toast", text: announcement, undoIds: applied.map((change) => change.id) }).catch(() => undefined);
    }
    this.finish(run, true);
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
        result = { dataUrl: await captureRunTab(run) };
      } else if (message.name === "use_site_control") {
        if (run.trigger !== "chat") throw new Error("Site controls require a chat request.");
        result = await sendToTab(run.tabId, { kind: "useSiteControl", input: message.input, userMessage: run.message }, run.documentId);
      } else {
        result = await sendToTab(run.tabId, { kind: "tool", name: message.name, input: message.input, source: "llm", requested: run.trigger === "chat" }, run.documentId);
      }
      if (!this.runs.has(run.runId)) return;
      if (message.name === "apply_change") this.afterApply(run, (message.input as { change: Change }).change, result as ApplyOutcome);
      if (message.name === "use_site_control") {
        const outcome = result as SiteControlOutcome;
        if (outcome.status === "applied") {
          run.siteControls.set(outcome.change.id, outcome.change);
          this.step(run, `Verified site control: ${outcome.change.summary}`, "good");
        }
      }
      if (message.name === "revert_change" && (result as { ok: boolean }).ok) {
        const { id } = message.input as { id: string };
        run.applied.delete(id);
        run.siteControls.delete(id);
      }
      this.hooks.tool(run.tabId, message.name, Date.now() - started, true, summarizeInput(message));
      this.send({ type: "toolResult", callId: message.callId, ok: true, result });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.hooks.tool(run.tabId, message.name, Date.now() - started, false, text);
      this.send({ type: "toolResult", callId: message.callId, ok: false, error: text });
      if (error instanceof PageChangedError) this.cancelRun(run, text);
    }
  }

  private afterApply(run: Run, change: Change, outcome: ApplyOutcome) {
    if (run.trigger === "page_load") void sendToTab(run.tabId, { kind: "busy", on: false }).catch(() => undefined);
    if (outcome.noop) return this.step(run, outcome.note ?? "Nothing changed", "info");
    if (!outcome.ok) return this.step(run, `Couldn't apply "${change.summary}": ${outcome.error}`, "bad");
    run.applied.set(change.id, { ...change, appliedAt: Date.now() });
    const deltas = (Object.keys(STAT_LABELS) as Array<keyof PageStats>)
      .filter((key) => outcome.before[key] !== outcome.after[key])
      .map((key) => `${STAT_LABELS[key]} ${outcome.before[key]} to ${outcome.after[key]}`);
    if (deltas.length) this.step(run, `Verified: ${deltas.join(", ")}`, "good");
    const missed = Object.entries(outcome.matched).filter(([, count]) => count === 0).map(([selector]) => selector);
    if (missed.length) this.step(run, `Matched nothing: ${missed.slice(0, 2).join(", ")}`, "warn");
    if (outcome.replaced?.length) this.step(run, `Replaced the earlier sort (${outcome.replaced.join(", ")})`, "good");
    if (outcome.lowContrast?.length) this.step(run, `${outcome.lowContrast.length} low-contrast spots to fix`, "warn");
  }
}

async function documentIdOf(tabId: number): Promise<string | undefined> {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: () => 0 });
    return injection?.documentId;
  } catch {
    return undefined;
  }
}

function summarizeInput(message: ToolCallMessage) {
  const input = message.input as { change?: Change; selector?: string };
  return input.change?.summary ?? input.selector ?? "";
}

// captureVisibleTab takes whatever tab is showing, so check it is still the run's tab and page before and after, and drop the pixels otherwise.
async function captureRunTab(run: Pick<Run, "tabId" | "windowId" | "origin">): Promise<string> {
  const check = async () => {
    const tab = await chrome.tabs.get(run.tabId).catch(() => null);
    const origin = tab?.url ? new URL(tab.url).origin : "";
    if (!tab || !tab.active || tab.windowId !== run.windowId || origin !== run.origin) throw new Error("The tab changed, so no screenshot was taken.");
    return tab.url;
  };
  const before = await check();
  const dataUrl = await captureScaled(run.windowId);
  if ((await check()) !== before) throw new Error("The tab changed, so the screenshot was discarded.");
  return dataUrl;
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

// Local wall clock with its UTC offset, so the model can resolve "until December 15" against the user's day.
function localClock(now = new Date()): { iso: string; timeZone: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const abs = Math.abs(offset);
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { iso, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
