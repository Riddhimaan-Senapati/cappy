import type { PageOutline } from "../shared/adaptation.js";

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /disregard (the |your |all )?(system|previous|prior) (prompt|instructions)/i,
  /you are now (a|an|the) /i,
  /(send|post|upload|exfiltrate|forward|email) (the |all |your |user'?s? )?(cookies?|tokens?|passwords?|session|credentials|profile)/i,
  /\b(assistant|agent|ai|llm|claude|gemini|chatgpt)\s*[:,]\s*(please )?(ignore|send|run|execute|navigate|open|unhide|reveal)/i,
  /system prompt/i,
  /document\.cookie/i,
];

export function detectInjection(page: PageOutline): string | null {
  const haystack = [page.title, ...page.headings, ...page.elements.map((element) => element.text ?? ""), page.textSample].join("\n");
  for (const pattern of INJECTION_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) return match[0];
  }
  return null;
}
