import { lineSite } from "./memory.js";
import type { BackgroundRequest, StatusInfo } from "./messages.js";
import { load, save, type StoredState } from "./storage.js";
import { adoptStyles, h, icon, type IconName } from "./ui/dom.js";
import { SETTINGS_CSS, TOKENS } from "./ui/theme.js";

interface Need {
  id: string;
  icon: IconName;
  title: string;
  sub: string;
  line: string;
}

const NEEDS: Need[] = [
  { id: "vision", icon: "eye", title: "Low vision", sub: "Larger text, stronger contrast", line: "Low vision: prefers larger text and strong contrast" },
  { id: "light", icon: "moon", title: "Light sensitivity", sub: "Dark, dimmer pages", line: "Light sensitive: prefers dark backgrounds and dimmer pages" },
  { id: "color", icon: "circle", title: "Colorblind", sub: "Colors you can tell apart", line: "" },
  { id: "reading", icon: "text", title: "Reading or dyslexia", sub: "Plain fonts, more spacing", line: "Reads more easily with plain fonts, wider spacing and shorter lines" },
  { id: "focus", icon: "target", title: "Focus", sub: "Fewer ads, popups and autoplay", line: "Easily distracted: hide ads, popups and autoplay" },
  { id: "motion", icon: "pause", title: "Motion sensitivity", sub: "No animation or moving video", line: "Motion sensitive: no animations or autoplaying video" },
  { id: "motor", icon: "keyboard", title: "Hand or motor limits", sub: "Bigger targets, clear focus", line: "Limited hand control: needs bigger click targets and clear focus outlines" },
];

const COLOR_TYPES = [
  { id: "red-green", label: "Red-green", line: "Red-green colorblind (deuteranopia)" },
  { id: "blue-yellow", label: "Blue-yellow", line: "Blue-yellow colorblind (tritanopia)" },
  { id: "unsure", label: "Not sure", line: "Colorblind, type not known" },
];

const SETUP_LINES = new Set([...NEEDS.map((need) => need.line), ...COLOR_TYPES.map((type) => type.line)].filter(Boolean));
const STEPS = ["Welcome", "Connect AI", "Your needs", "How to use it"];

const CSS = `
html, body { margin: 0; min-height: 100%; }
body { background: radial-gradient(ellipse at 15% 0%, rgba(110,168,255,0.12), transparent 50%), radial-gradient(ellipse at 90% 100%, rgba(244,114,182,0.08), transparent 45%), #0e0e13; color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.w { box-sizing: border-box; max-width: 620px; margin: 0 auto; padding: 48px 16px 64px; }
.w-top { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
.w-logo { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; background: var(--grad); color: #0d0d12; }
.w-top b { font-size: 15px; font-weight: 650; }
.w-top small { display: block; color: var(--muted); font-size: 12px; }
.w-steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 26px; }
.w-step { height: 4px; border-radius: 999px; background: rgba(255,255,255,0.1); overflow: hidden; }
.w-step i { display: block; height: 100%; width: 0; background: var(--grad); transition: width 0.5s var(--ease); }
.w-step.done i, .w-step.now i { width: 100%; }
.w-card { padding: 28px; border-radius: 20px; background: rgba(255,255,255,0.035); border: 1px solid var(--line); box-shadow: 0 24px 60px rgba(0,0,0,0.35); }
.w-card.enter { animation: w-in 0.45s var(--ease); }
@keyframes w-in { from { opacity: 0; transform: translateY(10px); } }
.w-card h1 { margin: 0 0 8px; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; outline: none; }
.w-card h1 em { font-style: normal; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.w-lead { margin: 0 0 22px; color: var(--muted); font-size: 14.5px; line-height: 1.55; }
.w-points { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.w-points li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 14px; background: var(--raise); }
.w-points li .ico { color: var(--accent); margin-top: 1px; }
.w-points b { display: block; font-weight: 600; font-size: 13.5px; }
.w-points small { color: var(--muted); font-size: 12.5px; }
.w-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
.w-need { all: unset; box-sizing: border-box; cursor: pointer; display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 14px; background: var(--raise); border: 1px solid transparent; transition: background 0.15s, border-color 0.2s, transform 0.2s var(--spring); }
.w-need:hover { background: var(--raise2); }
.w-need:active { transform: scale(0.98); }
.w-need[aria-pressed="true"] { border-color: rgba(139,155,255,0.6); background: rgba(139,155,255,0.12); }
.w-need .ico { color: var(--muted); margin-top: 1px; }
.w-need[aria-pressed="true"] .ico { color: var(--accent); }
.w-need b { display: block; font-size: 13.5px; font-weight: 600; }
.w-need small { color: var(--muted); font-size: 12px; }
.w-need:focus-visible, .w-btn:focus-visible, .w-primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.w-sub { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; animation: w-in 0.3s var(--ease); }
.w-sub label { color: var(--muted); font-size: 12.5px; margin-left: 2px; }
.w-extra { margin-top: 16px; display: flex; flex-direction: column; gap: 6px; }
.w-extra label { color: var(--muted); font-size: 12.5px; margin-left: 2px; }
.w-extra textarea { all: unset; box-sizing: border-box; width: 100%; min-height: 64px; padding: 10px 12px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); color: var(--text); font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; }
.w-extra textarea:focus { border-color: var(--accent); }
.w-extra textarea::placeholder { color: var(--faint); }
.w-nav { display: flex; align-items: center; gap: 10px; margin-top: 26px; }
.w-nav .grow { flex: 1; }
.w-btn { all: unset; box-sizing: border-box; cursor: pointer; padding: 10px 16px; border-radius: 12px; color: var(--muted); font-weight: 500; font-size: 13.5px; }
.w-btn:hover { color: var(--text); background: var(--raise); }
.w-primary { all: unset; box-sizing: border-box; cursor: pointer; padding: 11px 20px; border-radius: 12px; background: var(--grad); color: #0d0d12; font-weight: 650; font-size: 13.5px; display: inline-flex; align-items: center; gap: 8px; transition: transform 0.2s var(--spring), filter 0.2s; }
.w-primary:hover { filter: brightness(1.08); }
.w-primary:active { transform: scale(0.97); }
.w-server { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 14px; background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.22); }
.w-server b { font-size: 13.5px; }
.w-server p { margin: 0; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
code, kbd { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12.5px; padding: 2px 7px; border-radius: 7px; background: rgba(255,255,255,0.08); border: 1px solid var(--line); color: var(--text); white-space: nowrap; }
.w-keys { display: grid; gap: 8px; }
.w-key { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 14px; background: var(--raise); }
.w-key .what { flex: 1; }
.w-key .what b { display: block; font-size: 13.5px; font-weight: 600; }
.w-key .what small { color: var(--muted); font-size: 12.5px; }
.w-opts { margin-top: 16px; }
.w-done { text-align: center; padding: 12px 0 4px; }
.w-done .badge { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 18px; display: grid; place-items: center; background: var(--grad); color: #0d0d12; animation: w-pop 0.6s var(--spring); }
@keyframes w-pop { from { transform: scale(0.4); opacity: 0; } }
.w-done .w-nav { justify-content: center; }
@media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
`;

adoptStyles(document, TOKENS + SETTINGS_CSS + CSS);

const send = <T>(request: BackgroundRequest) => chrome.runtime.sendMessage(request) as Promise<T>;
const getStatus = () => send<StatusInfo>({ kind: "status" }).catch((): StatusInfo => ({ connected: false, busy: false }));

const initial = await load();
let step = 0;
let finished = false;
const chosen = new Set(NEEDS.filter((need) => need.line && initial.profile.includes(need.line)).map((need) => need.id));
let colorType = COLOR_TYPES.find((type) => initial.profile.includes(type.line))?.id ?? null;
if (colorType) chosen.add("color");
let extra = initial.profile.filter((line) => !SETUP_LINES.has(line) && !lineSite(line)).join("\n");
let status: StatusInfo = await getStatus();
let editingKey: string | null = null;
let keyDraft = "";
let shownView = "";

const root = h("main", "w");
document.body.append(root);

function button(className: string, label: string, onClick: () => void, children: Node[] = []) {
  const element = h("button", className, children.length ? "" : label, children);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

function toggleRow(label: string, sub: string, checked: boolean, onChange: (value: boolean) => void) {
  const toggle = h("button", "s-switch");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(checked));
  toggle.setAttribute("aria-label", label);
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return h("div", "s-row", "", [h("div", "grow", "", [h("div", "", label), h("small", "", sub)]), toggle]);
}

function profileLines(): string[] {
  const lines = NEEDS.filter((need) => chosen.has(need.id) && need.line).map((need) => need.line);
  if (chosen.has("color")) lines.push(COLOR_TYPES.find((type) => type.id === (colorType ?? "unsure"))!.line);
  const own = extra.split("\n").map((line) => line.trim().slice(0, 140)).filter(Boolean);
  return [...new Set([...lines, ...own])];
}

async function saveNeeds() {
  const state = await load();
  const siteLines = state.profile.filter((line) => lineSite(line));
  await save({ profile: [...profileLines(), ...siteLines] });
}

function welcomeStep(): Node[] {
  const point = (name: IconName, title: string, sub: string) => h("li", "", "", [icon(name, 18), h("div", "", "", [h("b", "", title), h("small", "", sub)])]);
  return [
    h("h1", "", "", [document.createTextNode("Every website, "), h("em", "", "adapted to you")]),
    h("p", "w-lead", "Tell it what you need in plain words and it changes the page you are on: colors, text, clutter, motion, focus. You can always undo."),
    h("ul", "w-points", "", [
      point("sparkle", "Say what you need", "\"Make this easier to read\", \"dim this page\", \"hide clickbait\"."),
      point("shield", "Your keys stay on your computer", "A small local server talks to the AI. The model never runs code on your pages."),
      point("undo", "Nothing is permanent", "Every change can be undone, and you can pause everything from settings."),
    ]),
  ];
}

function aiStep(): Node[] {
  const head = [h("h1", "", "Connect an AI"), h("p", "w-lead", "Pick the AI that does the adapting. A ChatGPT Plus or Pro plan works without an API key.")];
  if (!status.connected) {
    return [
      ...head,
      h("div", "w-server", "", [
        h("b", "", "The local server is not running"),
        h("p", "", "", [document.createTextNode("Open a terminal in the project folder and run "), h("code", "", "bun run dev"), document.createTextNode(". It keeps your keys on this computer. This page notices when it starts.")]),
      ]),
    ];
  }
  const rows = (status.providers ?? []).map((provider) => {
    const active = provider.id === status.activeProvider;
    let action: Node;
    if (provider.ready) {
      action = active ? h("span", "s-on", "In use") : button("s-btn s-small", "Use", () => void save({ provider: provider.id }).then(refresh));
    } else if (provider.setup === "signin") {
      action = button("s-btn s-small", "Sign in", () => void send({ kind: "chatgptLogin" }));
    } else {
      action = button("s-btn s-small", editingKey === provider.id ? "Cancel" : "Add key", () => {
        editingKey = editingKey === provider.id ? null : provider.id;
        keyDraft = "";
        render();
      });
    }
    const sub = provider.ready ? "Ready" : provider.setup === "signin" ? "Use your ChatGPT plan" : "Paste an API key";
    const row = h("div", `s-row${active ? " s-active" : ""}`, "", [h("span", `s-dot ${provider.ready ? "on" : "idle"}`), h("div", "grow", "", [h("div", "", provider.label), h("small", "", sub)]), action]);
    if (editingKey !== provider.id) return row;
    const input = h("input");
    input.type = "password";
    input.placeholder = `${provider.label} API key`;
    input.autocomplete = "off";
    input.value = keyDraft;
    input.setAttribute("aria-label", `${provider.label} API key`);
    input.addEventListener("input", () => (keyDraft = input.value));
    const form = h("form", "s-add", "", [input, h("button", "s-btn", "Save")]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      void send({ kind: "setKey", provider: provider.id, key: input.value.trim() });
      if (!status.activeProvider) void save({ provider: provider.id });
      editingKey = null;
      keyDraft = "";
      render();
    });
    queueMicrotask(() => input.focus());
    return h("div", "s-sec", "", [row, form]);
  });
  const notice = status.notice ? [h("div", `s-note${status.notice.level === "error" ? " s-error" : ""}`, status.notice.text)] : [];
  return [...head, h("section", "s-sec", "", [...rows, ...notice])];
}

function needsStep(): Node[] {
  const cards = NEEDS.map((need) => {
    const card = button("w-need", "", () => {
      if (chosen.has(need.id)) chosen.delete(need.id);
      else chosen.add(need.id);
      render();
    }, [icon(need.icon, 18), h("div", "", "", [h("b", "", need.title), h("small", "", need.sub)])]);
    card.setAttribute("aria-pressed", String(chosen.has(need.id)));
    return card;
  });
  const colorPicker = chosen.has("color")
    ? [
        h("div", "w-sub", "", [
          h("label", "", "Which kind?"),
          h(
            "div",
            "s-seg",
            "",
            COLOR_TYPES.map((type) => {
              const option = button("", type.label, () => {
                colorType = type.id;
                render();
              });
              option.setAttribute("aria-pressed", String((colorType ?? "unsure") === type.id));
              return option;
            }),
          ),
        ]),
      ]
    : [];
  const textarea = h("textarea");
  textarea.id = "w-extra";
  textarea.placeholder = "One per line, for example: I get migraines from bright pages";
  textarea.value = extra;
  textarea.addEventListener("input", () => (extra = textarea.value));
  const label = h("label", "", "Anything else it should know? (optional)");
  label.htmlFor = "w-extra";
  return [
    h("h1", "", "What would help you?"),
    h("p", "w-lead", "Pick any that apply. The agent uses these on every site, and you can change them later in settings."),
    h("div", "w-grid", "", cards),
    ...colorPicker,
    h("div", "w-extra", "", [label, textarea]),
  ];
}

async function shortcutFor(name: string) {
  const commands = await chrome.commands.getAll().catch(() => []);
  return commands.find((command) => command.name === name)?.shortcut || "not set";
}

let shortcuts = { bar: "Ctrl+Shift+Space", voice: "" };
void Promise.all([shortcutFor("toggle-spotlight"), shortcutFor("start-voice")]).then(([bar, voice]) => {
  shortcuts = { bar, voice };
  if (step === 3) render();
});

function basicsStep(state: StoredState): Node[] {
  const key = (keys: string, title: string, sub: string) => h("div", "w-key", "", [h("kbd", "", keys), h("div", "what", "", [h("b", "", title), h("small", "", sub)])]);
  return [
    h("h1", "", "How to use it"),
    h("p", "w-lead", "Open the bar on any page and say what you need. It shows each change as it happens."),
    h("div", "w-keys", "", [
      key(shortcuts.bar, "Open the bar", "Type a request, or pick a suggestion."),
      ...(shortcuts.voice && shortcuts.voice !== "not set" ? [key(shortcuts.voice, "Talk instead", "Opens the bar and listens.")] : []),
      h("div", "w-key", "", [icon("target", 18), h("div", "what", "", [h("b", "", "Change one thing"), h("small", "", "Use the target button in the bar, click an element, then say what to change about it.")])]),
      key("Ctrl+Z", "Undo", "Undoes the last request. Ctrl+Shift+Z puts it back."),
      key("Tab", "Harder request?", "While typing, Tab switches to the stronger model."),
    ]),
    h("div", "s-sec w-opts", "", [
      toggleRow("Adapt pages when they open", "Applies what clearly fits your needs on new sites", state.proactive, (value) => void save({ proactive: value })),
      toggleRow("Floating button", "A small button on pages to open the bar with a click", state.floatingButton, (value) => void save({ floatingButton: value })),
      toggleRow("Camera control", "Point, scroll and select with hand gestures (optional)", state.camera.enabled, (value) => void save({ camera: { ...state.camera, enabled: value } })),
    ]),
  ];
}

function doneView(): Node[] {
  const demo = status.connected
    ? [button("w-btn", "Try it on a demo page", () => void chrome.tabs.create({ url: "http://localhost:8787/demo/campus.html" }))]
    : [];
  return [
    h("div", "w-done", "", [
      h("div", "badge", "", [icon("check", 26)]),
      h("h1", "", "You're set"),
      h("p", "w-lead", "", [document.createTextNode("Go to any website and press "), h("kbd", "", shortcuts.bar), document.createTextNode(" to start.")]),
      h("div", "w-nav", "", [...demo, button("w-primary", "Close", () => globalThis.close())]),
    ]),
  ];
}

async function render() {
  const state = await load();
  const progress = h(
    "div",
    "w-steps",
    "",
    STEPS.map((name, index) => {
      const bar = h("div", `w-step${finished || index < step ? " done" : index === step ? " now" : ""}`, "", [h("i")]);
      bar.title = name;
      return bar;
    }),
  );
  progress.setAttribute("aria-label", finished ? "Setup complete" : `Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`);

  const body = finished ? doneView() : [welcomeStep, aiStep, needsStep, () => basicsStep(state)][step]();
  const ready = (status.providers ?? []).some((provider) => provider.ready);
  const nextLabel = step === 0 ? "Get started" : step === 1 && !ready ? "Skip for now" : step === STEPS.length - 1 ? "Finish" : "Continue";
  const nav = finished
    ? []
    : [
        h("div", "w-nav", "", [
          step > 0 ? button("w-btn", "Back", () => go(step - 1)) : null,
          h("div", "grow"),
          button(step === 1 && !ready ? "w-btn" : "w-primary", nextLabel, () => go(step + 1)),
        ]),
      ];

  const view = finished ? "done" : String(step);
  const card = h("section", `w-card${view !== shownView ? " enter" : ""}`, "", [...body, ...nav]);
  shownView = view;
  root.replaceChildren(
    h("header", "w-top", "", [h("div", "w-logo", "", [icon("sparkle", 18)]), h("div", "", "", [h("b", "", "Adaptive Agent"), h("small", "", finished ? "Setup complete" : `Setup · ${STEPS[step]}`)])]),
    progress,
    card,
  );
}

async function go(next: number) {
  if (step === 2) await saveNeeds();
  if (next >= STEPS.length) {
    finished = true;
    await save({ onboarded: true });
  } else step = next;
  editingKey = null;
  await render();
  root.querySelector<HTMLElement>("h1")?.setAttribute("tabindex", "-1");
  root.querySelector<HTMLElement>("h1")?.focus();
}

async function refresh() {
  status = await getStatus();
  if (step === 1 && !finished && !editingKey) await render();
}

setInterval(() => void refresh(), 2500);
await render();
