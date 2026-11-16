import type { OutlineElement, PageOutline, PageStats } from "../../../shared/adaptation.js";
import type { InjectionSurface } from "../../../shared/safety.js";
import type { InspectedElement } from "../../../shared/protocol.js";
import type { ContrastIssue } from "../../../shared/protocol.js";
import { accessibleName, AD_OR_POPUP, contrastInfo, contrastRatio, cssPath, isOwn, isVisible, LABELLABLE, queryAll, textElements } from "./dom.js";
import { findItemGroups } from "./item-groups.js";

const TARGETS = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea';
const MAX_ELEMENTS = 80;
const MAX_STATS_SCAN = 3000;

const clip = (text: string | null | undefined, length = 80) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, length);

export function computeStats(): PageStats {
  const texts = textElements(MAX_STATS_SCAN).filter(isVisible);
  const visible = (selector: string) => queryAll(selector).slice(0, MAX_STATS_SCAN).filter(isVisible);
  const media = queryAll("video, audio").slice(0, MAX_STATS_SCAN).filter((element) => !(element as HTMLMediaElement).paused);
  const running = document.getAnimations().filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return animation.playState === "running" && !(target instanceof Element && isOwn(target));
  });

  return {
    inputsWithoutLabel: visible(LABELLABLE).filter((element) => !accessibleName(element)).length,
    smallTargets: visible(TARGETS).filter((element) => {
      if (element.matches("a[href]") && element.closest("p, li")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width < 24 || rect.height < 24;
    }).length,
    smallText: texts.filter((element) => parseFloat(getComputedStyle(element).fontSize) < 14).length,
    lowContrastText: texts.filter((element) => contrastRatio(element) < 4.5).length,
    imagesWithoutAlt: visible("img:not([alt])").length,
    runningAnimations: running.length + media.length,
    visibleAdsOrPopups: visible(AD_OR_POPUP).length,
  };
}

// Groups by selector so one broken card style is reported once, worst first.
export function lowContrastSamples(limit = 8): ContrastIssue[] {
  const worst = new Map<string, ContrastIssue>();
  for (const element of textElements(2500).filter(isVisible)) {
    const info = contrastInfo(element);
    if (info.ratio >= 4.5) continue;
    const selector = cssPath(element);
    const existing = worst.get(selector);
    if (!existing || info.ratio < existing.ratio) {
      worst.set(selector, { selector, text: clip(element.textContent, 40), color: info.color, background: info.background, ratio: info.ratio });
    }
  }
  return [...worst.values()].sort((a, b) => a.ratio - b.ratio).slice(0, limit);
}

function describe(element: Element): OutlineElement {
  const style = getComputedStyle(element);
  const notes: string[] = [];
  if (element.matches(LABELLABLE) && !accessibleName(element)) {
    notes.push(`unlabeled ${element.getAttribute("type") ?? element.tagName.toLowerCase()}${element.getAttribute("placeholder") ? ` (placeholder "${clip(element.getAttribute("placeholder"), 40)}")` : ""}`);
  }
  if (element.matches("img:not([alt])")) notes.push("img without alt");
  if (style.position === "fixed" || style.position === "sticky") notes.push(`${style.position} position`);
  if (element.matches(AD_OR_POPUP)) notes.push("looks like ad/popup");
  if (style.animationName !== "none") notes.push(`animated (${style.animationName})`);
  if (element.matches("svg, canvas")) notes.push("graphic/chart");
  const fontSize = parseFloat(style.fontSize);
  if (fontSize < 14 && element.textContent?.trim()) notes.push(`font ${fontSize}px`);

  return {
    selector: cssPath(element),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") ?? undefined,
    text: elementText(element) || undefined,
    note: notes.join("; ") || undefined,
  };
}

function elementText(element: Element): string {
  return clip(element.matches(LABELLABLE) ? element.getAttribute("name") : element.textContent);
}

function headingTexts(): string[] {
  return queryAll("h1, h2, h3").map((heading) => clip(heading.textContent, 100)).filter(Boolean).slice(0, 25);
}

function outlineElements(): Element[] {
  const candidates = queryAll(
    `header, nav, main, aside, footer, form, [role], h1, h2, h3, ${LABELLABLE}, button, img, video, iframe, svg, canvas, table, ${AD_OR_POPUP}`,
  ).filter((element) => isVisible(element) && !element.closest("svg *"));

  const fixed = [...document.body.getElementsByTagName("*")]
    .slice(0, 4000)
    .filter((element) => !isOwn(element) && ["fixed", "sticky"].includes(getComputedStyle(element).position) && isVisible(element))
    .slice(0, 10);

  return [...new Set([...fixed, ...candidates])].slice(0, MAX_ELEMENTS);
}

// Title, heading text, outline text and the page sample. No contrast, groups or style hints.
export function readInjectionSurface(): InjectionSurface {
  return {
    title: document.title,
    headings: headingTexts(),
    texts: outlineElements().map((element) => elementText(element)),
    textSample: pageText(),
  };
}

function pageText(limit = 1500): string {
  let text = "";
  for (const element of textElements(2000)) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += ` ${node.textContent}`;
    }
    if (text.length > limit * 1.5) break;
  }
  return clip(text, limit);
}

export function readPage(): PageOutline {
  const elements = outlineElements();
  const bodyStyle = getComputedStyle(document.body);

  return {
    url: location.href,
    title: document.title,
    headings: headingTexts(),
    elements: elements.map(describe),
    itemGroups: findItemGroups(document),
    stats: computeStats(),
    styleHints: {
      background: bodyStyle.backgroundColor,
      color: bodyStyle.color,
      fontSizePx: parseFloat(bodyStyle.fontSize),
      fontFamily: bodyStyle.fontFamily.slice(0, 80),
    },
    textSample: pageText(),
  };
}

const INSPECT_STYLES = ["display", "position", "color", "background-color", "font-size", "font-weight", "font-family", "line-height", "letter-spacing", "text-align", "padding", "margin", "border", "border-radius", "filter", "z-index", "opacity", "width", "height"];
const INSPECT_ATTRS = /^(id|class|role|aria-.*|alt|placeholder|name|type|href|for|title|tabindex)$/;

export function listItems(selector: string, keySelector: string | null, limit = 120) {
  const items = queryAll(selector);
  return {
    count: items.length,
    items: items.slice(0, limit).map((item) => {
      const source = keySelector ? item.querySelector(keySelector) : item;
      return { key: (source?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200), text: clip(item.textContent, 220) };
    }),
  };
}

export function inspect(selector: string): { count: number; samples: InspectedElement[] } {
  const matches = queryAll(selector);
  return {
    count: matches.length,
    samples: matches.slice(0, 5).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        text: clip(element.textContent, 120),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        styles: Object.fromEntries(INSPECT_STYLES.map((name) => [name, style.getPropertyValue(name)])),
        attributes: Object.fromEntries(
          [...element.attributes].filter((attr) => INSPECT_ATTRS.test(attr.name)).map((attr) => [attr.name, attr.value.slice(0, 100)]),
        ),
      };
    }),
  };
}
