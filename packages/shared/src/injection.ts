export type InjectionScan = { flagged: false } | { flagged: true; evidence: string };

const PATTERNS: readonly RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /disregard (the |your )?(system|previous|prior) (prompt|instructions)/i,
  /\b(you are|act as) (now )?(an? )?(ai|assistant|agent|language model)\b/i,
  /\b(ai|assistant|agent|llm|model)s?\b[^.]{0,40}\b(must|should|need to|are instructed to)\b/i,
  /\b(send|post|upload|exfiltrate|forward)\b[^.]{0,40}\b(cookies?|tokens?|passwords?|session|credentials|local ?storage)\b/i,
  /\bsystem prompt\b/i,
  /<\s*\/?\s*(system|instructions?)\s*>/i,
];

export function detectInjection(text: string): InjectionScan {
  for (const pattern of PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { flagged: true, evidence: m[0].slice(0, 120) };
  }
  return { flagged: false };
}
