import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing, Tier } from "../../../shared/protocol.js";
import { ROUTING_LABELS, type StatusInfo } from "../messages.js";
import { load, save, type StoredState } from "../storage.js";
import { h, icon } from "./dom.js";

export interface SettingsContext {
  listChanges(): Promise<ActiveChange[]>;
  revert(id: string): Promise<void>;
  openDebug(): void;
  openShortcuts(): void;
  getStatus(): Promise<StatusInfo>;
  setKey(provider: string, key: string | null): void;
  signIn(): void;
  signOut(): void;
}

function toggle(label: string, sub: string, checked: boolean, onChange: (value: boolean) => void) {
  const button = h("button", "s-switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(checked));
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => onChange(!checked));
  return h("div", "s-row", "", [h("div", "grow", "", [h("div", "", label), h("small", "", sub)]), button]);
}

function modelPickers(state: StoredState, status: StatusInfo): Node[] {
  if (!status.activeProvider) return [];
  const defaults = status.models;
  const available = status.available ?? [];
  const field = (tier: Tier, label: string) => {
    const providerId = status.activeProvider ?? "";
    const current = state.modelChoices[providerId]?.[tier] ?? "";
    const options = [...new Set([current, ...available].filter(Boolean))];
    const select = h("select", "s-select");
    select.setAttribute("aria-label", `${label} model`);
    select.append(h("option", "", `Default${defaults ? ` (${defaults[tier]})` : ""}`));
    select.firstElementChild!.setAttribute("value", "");
    for (const id of options) {
      const option = h("option", "", id);
      option.value = id;
      select.append(option);
    }
    select.value = current;
    select.addEventListener("change", () => {
      const next = { ...(state.modelChoices[providerId] ?? {}) };
      if (select.value) next[tier] = select.value;
      else delete next[tier];
      void save({ modelChoices: { ...state.modelChoices, [providerId]: next } });
    });
    return h("label", "s-row", "", [h("div", "grow", "", [h("div", "", label), h("small", "", tier === "fast" ? "Used for simple requests and page-load checks" : "Used for harder requests and retries")]), select]);
  };
  return [field("fast", "Fast model"), field("frontier", "Pro model")];
}

function statusCard(status: StatusInfo) {
  const dot = h("span", `s-dot ${status.connected ? "on" : "off"}`);
  const title = status.connected ? `Connected to ${status.provider ?? "agent"}` : "Agent server offline";
  const sub = status.connected && status.models ? `${status.models.fast} (Fast) · ${status.models.frontier} (Pro)` : (status.error ?? "Start it with npm run dev");
  return h("div", "s-status", "", [dot, h("div", "", "", [h("b", "", title), h("small", "", sub)])]);
}

export function renderSettings(root: HTMLElement, ctx: SettingsContext): () => void {
  root.classList.add("s");
  let draft = "";
  let editingKey: string | null = null;
  let confirming: string | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let keyDraft = "";
  let disposed = false;

  const providerSection = (status: StatusInfo, state: StoredState): Node[] => {
    if (!status.connected) return [statusCard(status)];
    const rows = (status.providers ?? []).map((provider) => {
      const active = provider.id === status.activeProvider;
      const sub = provider.ready
        ? provider.models
          ? `${provider.models.fast} · ${provider.models.frontier}`
          : "Ready"
        : provider.setup === "signin"
          ? "Use your ChatGPT Plus or Pro plan"
          : "Paste an API key to use it";
      let action: Node;
      if (provider.ready) {
        const isSignin = provider.setup === "signin";
        const armed = confirming === provider.id;
        const disconnect = h("button", `s-link${armed ? " s-danger" : " s-quiet"}`, armed ? (isSignin ? "Confirm sign out" : "Confirm remove") : isSignin ? "Sign out" : "Remove key");
        disconnect.type = "button";
        disconnect.setAttribute("aria-label", armed ? `Confirm: disconnect ${provider.label}` : `Disconnect ${provider.label}`);
        disconnect.addEventListener("click", () => {
          clearTimeout(confirmTimer);
          if (!armed) {
            confirming = provider.id;
            confirmTimer = setTimeout(() => {
              confirming = null;
              queue();
            }, 4000);
            return queue();
          }
          confirming = null;
          if (isSignin) ctx.signOut();
          else ctx.setKey(provider.id, null);
          if (state.provider === provider.id) void save({ provider: null });
        });
        let primary: Node;
        if (active) primary = h("span", "s-on", "In use");
        else {
          const use = h("button", "s-btn s-small", "Use");
          use.type = "button";
          use.addEventListener("click", () => save({ provider: provider.id }));
          primary = use;
        }
        action = h("div", "s-acts", "", [disconnect, primary]);
      } else {
        const setup = h("button", "s-btn s-small", provider.setup === "signin" ? "Sign in" : editingKey === provider.id ? "Cancel" : "Add key");
        setup.type = "button";
        setup.addEventListener("click", () => {
          if (provider.setup === "signin") return ctx.signIn();
          editingKey = editingKey === provider.id ? null : provider.id;
          keyDraft = "";
          queue();
        });
        action = setup;
      }
      const row = h("div", `s-row${active ? " s-active" : ""}`, "", [h("span", `s-dot ${provider.ready ? "on" : "idle"}`), h("div", "grow", "", [h("div", "", provider.label), h("small", "", sub)]), action]);
      if (editingKey !== provider.id) return row;

      const input = h("input");
      input.type = "password";
      input.placeholder = `${provider.label} API key`;
      input.value = keyDraft;
      input.autocomplete = "off";
      input.setAttribute("aria-label", `${provider.label} API key`);
      input.addEventListener("input", () => (keyDraft = input.value));
      const form = h("form", "s-add", "", [input, h("button", "s-btn", "Save")]);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        ctx.setKey(provider.id, input.value.trim());
        editingKey = null;
        keyDraft = "";
        if (!state.provider) void save({ provider: provider.id });
      });
      queueMicrotask(() => input.focus());
      return h("div", "s-sec", "", [row, form]);
    });
    const notice = status.notice ? [h("div", `s-note${status.notice.level === "error" ? " s-error" : ""}`, status.notice.text)] : [];
    const hint = status.activeProvider ? [] : [h("div", "s-note", "Sign in with ChatGPT or add a key to start. Keys stay on your computer, in the local server.")];
    return [h("section", "s-sec", "", [h("h3", "", "AI provider"), ...rows, ...notice, ...hint])];
  };
  let queued = false;

  const paint = async () => {
    const [state, changes, status] = await Promise.all([load(), ctx.listChanges().catch(() => []), ctx.getStatus().catch(() => ({ connected: false, busy: false }))]);
    if (disposed) return;
    const focused = root.getRootNode() instanceof ShadowRoot ? (root.getRootNode() as ShadowRoot).activeElement : document.activeElement;
    const hadFocus = focused instanceof HTMLInputElement && root.contains(focused);

    const chips = state.profile.length
      ? state.profile.map((line, index) => {
          const remove = h("button", "s-x", "", [icon("x", 12)]);
          remove.type = "button";
          remove.setAttribute("aria-label", `Remove ${line}`);
          remove.addEventListener("click", () => save({ profile: state.profile.filter((_, i) => i !== index) }));
          return h("span", "s-chip", line, [remove]);
        })
      : [h("div", "s-empty", "Nothing yet. Tell the agent about your needs, or add a line.")];

    const input = h("input");
    input.placeholder = "Add a need, e.g. light sensitive";
    input.value = draft;
    input.setAttribute("aria-label", "Add a profile line");
    input.addEventListener("input", () => (draft = input.value));
    const form = h("form", "s-add", "", [input, h("button", "s-btn", "Add")]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const line = input.value.trim();
      if (!line) return;
      draft = "";
      await save({ profile: [...state.profile, line] });
    });

    const segments = (["auto", "fast", "frontier"] as Routing[]).map((value) => {
      const button = h("button", "", ROUTING_LABELS[value]);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.routing === value));
      button.addEventListener("click", () => save({ routing: value }));
      return button;
    });
    const routingNote =
      state.routing === "auto"
        ? "Picks per request: Fast for simple ones, Pro for harder ones or when Fast misses."
        : state.routing === "fast"
          ? "Quickest. Press Tab in the bar to use Pro for a harder request."
          : "Most capable, slower. Press Tab in the bar to go back to Fast.";

    const changeRows = changes.length
      ? changes.map((change) => {
          const undo = h("button", "s-link", "Undo");
          undo.type = "button";
          undo.addEventListener("click", async () => {
            await ctx.revert(change.id);
            queue();
          });
          return h("div", "s-change", "", [
            h("div", "top", "", [h("b", "", change.summary), h("span", "s-tag", change.scope === "everywhere" ? "all sites" : "this site"), undo]),
            h("div", "why", change.reason),
          ]);
        })
      : [h("div", "s-empty", "No changes on this page yet.")];

    const shortcuts = h("button", "s-btn", "", [icon("keyboard", 15), document.createTextNode("Shortcuts")]);
    shortcuts.type = "button";
    shortcuts.addEventListener("click", () => ctx.openShortcuts());
    const debug = h("button", "s-btn", "", [icon("bug", 15), document.createTextNode("Debug panel")]);
    debug.type = "button";
    debug.addEventListener("click", () => ctx.openDebug());

    const section = (title: string, ...children: Node[]) => h("section", "s-sec", "", [h("h3", "", title), ...children]);
    const set = <K extends keyof StoredState>(key: K) => (value: StoredState[K]) => save({ [key]: value } as Partial<StoredState>);

    root.replaceChildren(
      ...providerSection(status, state),
      section(
        "General",
        toggle("Adaptations", "Master switch. Off reverts everything.", !state.paused, (on) => set("paused")(!on)),
        toggle("Act on page load", "Fix pages for you before you ask.", state.proactive, set("proactive")),
        toggle("Floating button", "A small button that opens the bar.", state.floatingButton, set("floatingButton")),
      ),
      section("Model", h("div", "s-seg", "", segments), h("div", "s-note", routingNote), ...modelPickers(state, status)),
      section("Your profile", h("div", "s-chips", "", chips), form),
      section("On this page", ...changeRows),
      h("div", "s-foot", "", [shortcuts, debug]),
    );
    if (hadFocus) root.querySelector<HTMLInputElement>(".s-add input")?.focus();
  };

  const queue = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void paint();
    });
  };

  const onStorage = () => queue();
  chrome.storage.onChanged.addListener(onStorage);
  void paint();
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
