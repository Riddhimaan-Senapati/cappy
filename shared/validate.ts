// Kept free of zod so the content script stays small.
import type { Change } from "./adaptation.js";

export const SAFE_ATTRIBUTES = [
  "aria-label",
  "aria-hidden",
  "aria-describedby",
  "alt",
  "title",
  "role",
  "tabindex",
  "lang",
  "autocomplete",
  "inputmode",
] as const;

export const REMOVABLE_ATTRIBUTES = ["autoplay", "loop", "tabindex", "aria-hidden", "disabled", "readonly"] as const;

const DOM_OPS = new Set(["addLabel", "setAttribute", "removeAttribute", "pauseMedia"]);
const BLOCKS = new Set(["colorblind", "textScale", "stopMotion"]);

const FORBIDDEN_CSS: Array<[RegExp, string]> = [
  [/url\s*\(/i, "url() can load outside resources"],
  [/@import/i, "@import can load outside resources"],
  [/@font-face/i, "@font-face can load outside resources"],
  [/image-set\s*\(/i, "image-set() can load outside resources"],
  [/expression\s*\(/i, "expression() runs script"],
  [/javascript:/i, "javascript: URLs"],
  [/-moz-binding|behavior\s*:/i, "script bindings"],
  [/<\/?style|<script/i, "markup inside CSS"],
  [/\\/, "CSS escapes can hide forbidden tokens"],
];

const SAFE_CONTENT_VALUES = new Set(["none", "normal", '""', "''"]);

export const LIMITS = { cssChars: 6000, changes: 8, domOps: 40, labelChars: 80, attrChars: 200 };

export function scanCss(css: string): string | null {
  if (css.length > LIMITS.cssChars) return `CSS longer than ${LIMITS.cssChars} characters`;
  const hit = FORBIDDEN_CSS.find(([pattern]) => pattern.test(css));
  if (hit) return hit[1];
  for (const match of css.matchAll(/(?<![-\w])content\s*:\s*([^;}]*)/gi)) {
    const value = match[1].replace(/!important/i, "").trim();
    if (!SAFE_CONTENT_VALUES.has(value)) return "content: can paint fake text on the page";
  }
  return null;
}

export function validateChange(change: Change): string | null {
  if (change.scope !== "site" && change.scope !== "everywhere") return "bad scope";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(change.id)) return `bad id "${change.id}"`;
  if (!change.css && !change.dom?.length && !change.block) return "change does nothing";
  if (change.css) {
    const problem = scanCss(change.css);
    if (problem) return `CSS rejected: ${problem}`;
  }
  if (change.dom && change.dom.length > LIMITS.domOps) return "too many DOM operations";
  for (const op of change.dom ?? []) {
    if (!DOM_OPS.has(op.op) || typeof op.selector !== "string") return `unknown DOM op "${op.op}"`;
    if (op.op === "setAttribute" && !(SAFE_ATTRIBUTES as readonly string[]).includes(op.name)) return `attribute "${op.name}" not allowed`;
    if (op.op === "removeAttribute" && !(REMOVABLE_ATTRIBUTES as readonly string[]).includes(op.name)) return `attribute "${op.name}" not removable`;
    if (op.op === "addLabel" && op.text.length > LIMITS.labelChars) return "label text too long";
    if (op.op === "setAttribute" && op.value.length > LIMITS.attrChars) return "attribute value too long";
  }
  if (change.block && !BLOCKS.has(change.block.name)) return `unknown block "${change.block.name}"`;
  if (change.block?.name === "textScale") {
    change.block.scale = Math.min(2, Math.max(1, Number(change.block.scale) || 1));
  }
  return null;
}
