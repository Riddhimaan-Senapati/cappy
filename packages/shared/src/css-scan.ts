export type CssScan = { ok: true } | { ok: false; reason: string };

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/url\s*\(/i, "url() can load or leak to outside hosts"],
  [/@import/i, "@import can load outside stylesheets"],
  [/image-set\s*\(/i, "image-set() can load outside images"],
  [/expression\s*\(/i, "expression() executes script in legacy engines"],
  [/javascript:/i, "javascript: URLs are not allowed"],
  [/-moz-binding|behavior\s*:/i, "binding properties can execute code"],
  [/\\/, "escape sequences can hide forbidden tokens"],
  [/<\/?style|<script/i, "markup is not allowed in CSS"],
  [/@font-face/i, "@font-face can load outside fonts"],
  [/content\s*:\s*(?!\s*(none|normal|""|'')\s*[;}!]|\s*(none|normal|""|'')\s*$)/i, "content text could fake page text"],
];

export function scanCss(css: string): CssScan {
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(css)) return { ok: false, reason };
  }
  return { ok: true };
}
