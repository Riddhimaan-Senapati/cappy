import type { OutlineElement, PageOutline, PageStats } from "../../../shared/adaptation.js";
import type { InspectedElement } from "../../../shared/protocol.js";
import { accessibleName, AD_OR_POPUP, contrastRatio, cssPath, isOwn, isVisible, LABELLABLE, queryAll, textElements } from "./dom.js";
import { findItemGroups } from "./item-groups.js";

const TARGETS = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea';
const MAX_ELEMENTS = 80;

const clip = (text: string | null | undefined, length = 80) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, length);

export function computeStats(): PageStats {
  const texts = textElements(3000).filter(isVisible);
  const media = [...document.querySelectorAll<HTMLMediaElement>("video, audio")].filter((element) => !element.paused);

  return {
    inputsWithoutLabel: queryAll(LABELLABLE).filter((element) => isVisible(element) && !accessibleName(element)).length,
    smallTargets: queryAll(TARGETS).filter((element) => {
      if (!isVisible(element) || element.closest("p, li")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width < 24 || rect.height < 24;
    }).length,
    smallText: texts.filter((element) => parseFloat(getComputedStyle(element).fontSize) < 14).length,
    lowContrastText: texts.filter((element) => contrastRatio(element) < 4.5).length,
    imagesWithoutAlt: queryAll("img:not([alt])").filter(isVisible).length,
    runningAnimations: document.getAnimations().filter((animation) => animation.playState === "running").length + media.length,
    visibleAdsOrPopups: queryAll(AD_OR_POPUP).filter(isVisible).length,
  };
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
    text: clip(element.matches(LABELLABLE) ? element.getAttribute("name") : element.textContent) || undefined,
    note: notes.join("; ") || undefined,
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
  const candidates = queryAll(
    `header, nav, main, aside, footer, form, [role], h1, h2, h3, ${LABELLABLE}, button, img, video, iframe, svg, canvas, table, ${AD_OR_POPUP}`,
  ).filter((element) => isVisible(element) && !element.closest("svg *"));

  const fixed = [...document.body.getElementsByTagName("*")]
    .slice(0, 4000)
    .filter((element) => !isOwn(element) && ["fixed", "sticky"].includes(getComputedStyle(element).position) && isVisible(element))
    .slice(0, 10);

  const unique = [...new Set([...fixed, ...candidates])].slice(0, MAX_ELEMENTS);
  const bodyStyle = getComputedStyle(document.body);

  return {
    url: location.href,
    title: document.title,
    headings: queryAll("h1, h2, h3").map((heading) => clip(heading.textContent, 100)).filter(Boolean).slice(0, 25),
    elements: unique.map(describe),
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

const INSPECT_STYLES = ["display", "position", "color", "background-color", "font-size", "font-family", "line-height", "filter", "z-index", "opacity", "width", "height"];
const INSPECT_ATTRS = /^(id|class|role|aria-.*|alt|placeholder|name|type|href|for|title|tabindex)$/;

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
