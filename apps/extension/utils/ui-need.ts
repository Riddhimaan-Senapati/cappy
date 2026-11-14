import type { NeedKind } from "@browser-agent/shared";

// First match wins; anything else is kept as a free-text preference.
const RULES: ReadonlyArray<readonly [NeedKind, RegExp]> = [
  ["color_vision", /colou?r|blind/i],
  ["light_sensitivity", /bright|flash|light|glare/i],
  ["text_size", /text|read|font|small/i],
  ["motor", /wrist|hand|motor|click|tremor/i],
  ["focus", /focus|distract|adhd/i],
];

export function guessNeedKind(text: string): NeedKind {
  return RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "preference";
}
