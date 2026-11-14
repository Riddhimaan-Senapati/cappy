import type { BlockOf } from "@browser-agent/shared";
import { Journal } from "./journal";

export type DarkStrategy = "class" | "media" | "toggle" | "invert";
export type DarkOutcome = DarkStrategy | "already-dark" | "none";

const STRATEGY_ORDER: readonly DarkStrategy[] = ["class", "media", "toggle", "invert"];
const STORAGE_KEY = "darkModeStrategy";
const DARK_LUMINANCE = 0.2;
const MAX_SWITCH_TRIES = 4;
const MAX_TOGGLE_TRIES = 3;
const TOGGLE_SETTLE_MS = 300;
const STYLE_MARK = "dark-mode";

const INVERT_CSS = `
html { filter: invert(1) hue-rotate(180deg) !important; background: #fff !important; }
img, video, picture, canvas, svg, iframe, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }
`;

export type Rgba = { r: number; g: number; b: number; a: number };
export type Tone = { background: number; text?: number };

export type ThemeToken = { kind: "class"; name: string } | { kind: "attr"; name: string; value: string };
export type ThemeSwitch = { token: ThemeToken; alsoBody: boolean };

const THEME_TOKENS: ReadonlyArray<{ token: ThemeToken; pattern: RegExp }> = [
  classToken("dark"),
  classToken("theme-dark"),
  classToken("dark-mode"),
  classToken("night"),
  attrToken("data-theme", "dark"),
  attrToken("data-color-mode", "dark"),
  attrToken("data-bs-theme", "dark"),
  attrToken("data-mode", "dark"),
  attrToken("theme", "dark"),
];

const TOGGLE_SELECTOR = "button, [role=button], [role=switch], [aria-pressed], input[type=checkbox]";
const TOGGLE_NAME = /dark|night|theme|appearance/i;
const SETTINGS_NAME = /setting|preference|customi[sz]e/i;

let lastOutcome: DarkOutcome | undefined;

export function lastDarkStrategy(): DarkOutcome | undefined {
  return lastOutcome;
}

// Tries the site's own dark theme before inverting colors, and keeps every step undoable.
export function applyDarkMode(cfg: BlockOf<"dark_mode">, doc: Document = document): () => void {
  const session = new DarkSession(cfg, doc);
  void session.run().catch((err: unknown) => {
    console.warn("dark mode failed", err);
    session.undo();
  });
  return () => session.undo();
}

class DarkSession {
  private readonly undos: Array<() => void> = [];
  private readonly toggled: HTMLElement[] = [];
  private cancelled = false;
  private undone = false;

  constructor(
    private readonly cfg: BlockOf<"dark_mode">,
    private readonly doc: Document,
  ) {}

  async run(): Promise<void> {
    if (isAlreadyDark(readTone(this.doc))) return this.finish("already-dark");
    const host = this.doc.location?.hostname ?? "";
    const remembered = await readRemembered(host);
    for (const strategy of strategyOrder(remembered, this.cfg.allowSiteControls)) {
      if (this.cancelled) return;
      if (await this.attempt(strategy)) {
        this.finish(strategy);
        await rememberStrategy(host, strategy);
        return;
      }
    }
    this.finish("none");
  }

  undo(): void {
    if (this.undone) return;
    this.undone = true;
    this.cancelled = true;
    if (this.toggled.length > 0 && isAlreadyDark(readTone(this.doc))) {
      for (const el of this.toggled) if (el.isConnected) el.click();
    }
    for (const undo of this.undos.reverse()) undo();
    this.undos.length = 0;
  }

  private finish(outcome: DarkOutcome): void {
    lastOutcome = outcome;
    console.info(`dark mode: ${outcome}`);
  }

  private attempt(strategy: DarkStrategy): Promise<boolean> {
    if (strategy === "class") return Promise.resolve(this.tryThemeSwitches());
    if (strategy === "media") return Promise.resolve(this.tryDarkMedia());
    if (strategy === "toggle") return this.tryToggles();
    this.injectInvert();
    return Promise.resolve(true);
  }

  private tryThemeSwitches(): boolean {
    const switches = themeSwitchesFromSelectors(selectorsFromSheets(this.doc.styleSheets)).slice(0, MAX_SWITCH_TRIES);
    const before = readTone(this.doc);
    for (const sw of switches) {
      const journal = new Journal();
      applyThemeSwitch(journal, this.doc, sw);
      if (isDarkened(before, readTone(this.doc))) {
        this.undos.push(() => journal.unwind());
        return true;
      }
      journal.unwind();
    }
    return false;
  }

  private tryDarkMedia(): boolean {
    const texts = darkMediaRuleTexts(this.doc.styleSheets);
    if (texts.length === 0) return false;
    const before = readTone(this.doc);
    const journal = new Journal();
    const style = injectStyle(this.doc, texts.join("\n"));
    journal.add(() => style.remove());
    if (isDarkened(before, readTone(this.doc))) {
      this.undos.push(() => journal.unwind());
      return true;
    }
    journal.unwind();
    return false;
  }

  private async tryToggles(): Promise<boolean> {
    if (!this.cfg.allowSiteControls) return false;
    const before = readTone(this.doc);
    const candidates = findToggleCandidates(this.doc, isVisible).slice(0, MAX_TOGGLE_TRIES);
    for (const el of candidates) {
      if (this.cancelled) return false;
      el.click();
      await sleep(TOGGLE_SETTLE_MS);
      if (!this.cancelled && isDarkened(before, readTone(this.doc))) {
        this.toggled.push(el);
        return true;
      }
      el.click();
      if (this.cancelled) return false;
      await sleep(TOGGLE_SETTLE_MS);
    }
    return false;
  }

  private injectInvert(): void {
    const journal = new Journal();
    const style = injectStyle(this.doc, INVERT_CSS);
    journal.add(() => style.remove());
    this.undos.push(() => journal.unwind());
  }
}

function classToken(name: string): { token: ThemeToken; pattern: RegExp } {
  return {
    token: { kind: "class", name },
    pattern: new RegExp(`\\.${name}(?![\\w-])`),
  };
}

function attrToken(name: string, value: string): { token: ThemeToken; pattern: RegExp } {
  return {
    token: { kind: "attr", name, value },
    pattern: new RegExp(`\\[\\s*${name}\\s*=\\s*["']?${value}["']?\\s*\\]`, "i"),
  };
}

export function themeSwitchesFromSelectors(selectors: string[]): ThemeSwitch[] {
  const out: ThemeSwitch[] = [];
  const seen = new Set<string>();
  for (const raw of selectors) {
    for (const part of raw.split(",")) {
      const selector = part.trim();
      for (const { token, pattern } of THEME_TOKENS) {
        if (!pattern.test(selector)) continue;
        const alsoBody = /^body(?![\w-])/i.test(selector);
        const key = `${JSON.stringify(token)}|${alsoBody}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ token, alsoBody });
      }
    }
  }
  return out;
}

export function applyThemeSwitch(journal: Journal, doc: Document, sw: ThemeSwitch): void {
  const html = doc.documentElement;
  const targets = sw.alsoBody && doc.body ? [html, doc.body] : [html];
  for (const el of targets) journal.touch(el);
  for (const el of targets) {
    if (sw.token.kind === "class") el.classList.add(sw.token.name);
    else el.setAttribute(sw.token.name, sw.token.value);
  }
  html.style.setProperty("color-scheme", "dark");
}

export function selectorsFromSheets(sheets: ArrayLike<CSSStyleSheet>): string[] {
  const out: string[] = [];
  for (const sheet of Array.from(sheets)) {
    if (isOurStyle(sheet.ownerNode)) continue;
    walkRules(readRules(sheet), (rule) => {
      if ("selectorText" in rule && typeof rule.selectorText === "string") out.push(rule.selectorText);
    });
  }
  return out;
}

export function darkMediaRuleTexts(sheets: ArrayLike<CSSStyleSheet>): string[] {
  const out: string[] = [];
  for (const sheet of Array.from(sheets)) {
    if (isOurStyle(sheet.ownerNode)) continue;
    collectDarkMedia(readRules(sheet), out);
  }
  return out;
}

function collectDarkMedia(rules: CSSRuleList | undefined, out: string[]): void {
  if (!rules) return;
  for (const rule of Array.from(rules)) {
    if (!("media" in rule) || !("cssRules" in rule)) continue;
    const media = rule as CSSMediaRule;
    if (isDarkQuery(media.media.mediaText)) {
      for (const inner of Array.from(media.cssRules)) out.push(inner.cssText);
    } else {
      collectDarkMedia(media.cssRules, out);
    }
  }
}

export function isDarkQuery(mediaText: string): boolean {
  const normalized = mediaText.toLowerCase().replace(/\s+/g, "");
  return normalized.includes("prefers-color-scheme:dark") && !normalized.includes("not");
}

function walkRules(rules: CSSRuleList | undefined, visit: (rule: CSSRule) => void): void {
  if (!rules) return;
  for (const rule of Array.from(rules)) {
    visit(rule);
    if ("cssRules" in rule && rule.cssRules) walkRules(rule.cssRules as CSSRuleList, visit);
  }
}

function readRules(sheet: CSSStyleSheet): CSSRuleList | undefined {
  try {
    return sheet.cssRules;
  } catch {
    return undefined;
  }
}

function isOurStyle(node: Element | ProcessingInstruction | null): boolean {
  return node instanceof Element && node.hasAttribute("data-ba") && node.getAttribute("data-ba") === STYLE_MARK;
}

export function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text;
  return el.getAttribute("title")?.trim() ?? "";
}

export function findToggleCandidates(doc: Document, isShown: (el: Element) => boolean): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(TOGGLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute("href") || el.tagName === "A") return false;
    if (el.tagName === "BUTTON" && el.closest("form") && (el.getAttribute("type") ?? "submit") === "submit") return false;
    if ((el as HTMLButtonElement).disabled) return false;
    const name = accessibleName(el);
    return TOGGLE_NAME.test(name) && !SETTINGS_NAME.test(name) && isShown(el);
  });
}

function isVisible(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  return el.getClientRects().length > 0 && win.getComputedStyle(el).visibility !== "hidden";
}

const RGBA_RE = /rgba?\(\s*([\d.]+)(?:,|\s)+([\d.]+)(?:,|\s)+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i;

export function parseRgba(css: string): Rgba | undefined {
  const m = RGBA_RE.exec(css.trim());
  if (!m) return undefined;
  const raw = m[4];
  const alpha = raw === undefined ? 1 : raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
  return { r: parseFloat(m[1]!), g: parseFloat(m[2]!), b: parseFloat(m[3]!), a: Math.min(1, Math.max(0, alpha)) };
}


// Composites over an opaque backdrop (white by default) before taking WCAG relative luminance.
export function relativeLuminance(c: Rgba, backdrop = 255): number {
  const linear = (channel: number): number => {
    const v = (channel * c.a + backdrop * (1 - c.a)) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

export function isAlreadyDark(tone: Tone): boolean {
  return tone.background < DARK_LUMINANCE;
}

export function isDarkened(before: Tone, after: Tone): boolean {
  if (after.background >= DARK_LUMINANCE) return false;
  if (after.background >= before.background) return false;
  return after.text === undefined || after.text > after.background;
}

export function strategyOrder(remembered: DarkStrategy | undefined, allowSiteControls: boolean): DarkStrategy[] {
  const base = STRATEGY_ORDER.filter((s) => s !== "toggle" || allowSiteControls);
  if (!remembered || !base.includes(remembered)) return [...base];
  return [remembered, ...base.filter((s) => s !== remembered)];
}

export function readTone(doc: Document): Tone {
  const win = doc.defaultView ?? window;
  const sample = doc.querySelector<HTMLElement>("main") ?? doc.body ?? doc.documentElement;
  const canvasBase = colorSchemeOf(doc, win).includes("dark") ? 0 : 255;
  const bg = effectiveBackground(sample, doc, win) ?? { r: canvasBase, g: canvasBase, b: canvasBase, a: 1 };
  const text = parseColor(win.getComputedStyle(sample).color, doc);
  return { background: relativeLuminance(bg), text: text ? relativeLuminance(text) : undefined };
}

function colorSchemeOf(doc: Document, win: Window): string {
  return win.getComputedStyle(doc.documentElement).colorScheme ?? "";
}

function effectiveBackground(start: HTMLElement, doc: Document, win: Window): Rgba | undefined {
  for (let el: HTMLElement | null = start; el; el = el.parentElement) {
    const color = parseColor(win.getComputedStyle(el).backgroundColor, doc);
    if (color && color.a > 0) return color;
  }
  return undefined;
}

// Canvas parsing covers color formats (oklch, color()) that the regex cannot read.
function parseColor(css: string, doc: Document): Rgba | undefined {
  const direct = parseRgba(css);
  if (direct) return direct;
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  } catch {
    return undefined;
  }
}

function injectStyle(doc: Document, css: string): HTMLStyleElement {
  const style = doc.createElement("style");
  style.setAttribute("data-ba", STYLE_MARK);
  style.textContent = css;
  // Appended last so the injected rules win ties with the site's own CSS in the body.
  (doc.body ?? doc.documentElement).append(style);
  return style;
}

const STORAGE_HOSTS_MAX = 200;

function storageLocal(): chrome.storage.LocalStorageArea | undefined {
  return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
}

async function readRemembered(host: string): Promise<DarkStrategy | undefined> {
  if (!host) return undefined;
  try {
    const area = storageLocal();
    if (!area) return undefined;
    const stored = (await area.get(STORAGE_KEY))[STORAGE_KEY] as Record<string, unknown> | undefined;
    const value = stored?.[host];
    return STRATEGY_ORDER.find((s) => s === value);
  } catch {
    return undefined;
  }
}

async function rememberStrategy(host: string, strategy: DarkStrategy): Promise<void> {
  if (!host) return;
  try {
    const area = storageLocal();
    if (!area) return;
    const stored = (await area.get(STORAGE_KEY))[STORAGE_KEY] as Record<string, string> | undefined;
    const next: Record<string, string> = { ...stored, [host]: strategy };
    const hosts = Object.keys(next);
    if (hosts.length > STORAGE_HOSTS_MAX) delete next[hosts[0]!];
    await area.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn("could not remember dark mode strategy", err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
