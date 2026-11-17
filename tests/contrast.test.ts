import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOKENS } from "../extension/src/ui/theme.js";

const DARK = ":host, :root {";
const LIGHT = ':host([data-theme="light"]), :root[data-theme="light"] {';

function block(selector: string): Record<string, string> {
  const start = TOKENS.indexOf(selector);
  assert.ok(start >= 0, `missing block ${selector}`);
  const body = TOKENS.slice(start + selector.length, TOKENS.indexOf("}", start));
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[match[1]] = match[2].trim();
  return tokens;
}

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected an opaque hex color, got ${hex}`);
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const TEXT_TOKENS = ["--text", "--muted", "--accent", "--accent-text", "--pro-text", "--good", "--warn", "--bad"];
const SURFACES = ["--solid", "--panel-solid"];
const THEMES: Array<[string, string]> = [
  ["dark", DARK],
  ["light", LIGHT],
];

describe("theme token contrast (WCAG 2.2 AA)", () => {
  for (const [name, selector] of THEMES) {
    const tokens = block(selector);
    describe(`${name} theme`, () => {
      for (const surface of SURFACES) {
        for (const token of TEXT_TOKENS) {
          it(`${token} on ${surface} reaches 4.5:1`, () => {
            const ratio = contrast(tokens[token], tokens[surface]);
            assert.ok(ratio >= 4.5, `${token} ${tokens[token]} on ${surface} ${tokens[surface]} is ${ratio.toFixed(2)}:1`);
          });
        }
        it(`--faint on ${surface} reaches 3:1 (non-text only)`, () => {
          const ratio = contrast(tokens["--faint"], tokens[surface]);
          assert.ok(ratio >= 3, `--faint on ${surface} is ${ratio.toFixed(2)}:1`);
        });
      }
    });
  }

  it("prefers-contrast strengthens the line token in both themes", () => {
    const more = TOKENS.slice(TOKENS.indexOf("@media (prefers-contrast: more)"));
    assert.match(more, /--line:\s*rgba\(255, 255, 255, 0\.\d+\)/);
    assert.match(more, /--line:\s*rgba\(20, 20, 35, 0\.\d+\)/);
  });
});
