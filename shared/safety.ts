import type { PageOutline } from "./adaptation.js";

export interface InjectionSurface {
  title: string;
  headings: string[];
  texts: string[];
  textSample: string;
}

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /disregard (the |your |all )?(system|previous|prior) (prompt|instructions)/i,
  /you are now (a|an|the) /i,
  /(send|post|upload|exfiltrate|forward|email) (the |all |your |user'?s? )?(cookies?|tokens?|passwords?|session|credentials|profile)/i,
  /\b(assistant|agent|ai|llm|claude|gemini|chatgpt)\s*[:,]\s*(please )?(ignore|send|run|execute|navigate|open|unhide|reveal)/i,
  /system prompt/i,
  /document\.cookie/i,
];

export function detectInjectionText(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export function detectInjectionFields(surface: InjectionSurface): string | null {
  return detectInjectionText([surface.title, ...surface.headings, ...surface.texts, surface.textSample].join("\n"));
}

export function detectInjection(page: PageOutline): string | null {
  return detectInjectionFields({
    title: page.title,
    headings: page.headings,
    texts: page.elements.map((element) => element.text ?? ""),
    textSample: page.textSample,
  });
}
