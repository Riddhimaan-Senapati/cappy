export const MAX_PAGE_CHARS = 20_000;
export const MAX_CHUNK_CHARS = 200;

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function cleanForSpeech(text: string): string {
  return normalizeSpace(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\n]*\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1"),
  );
}

export function capForSpeech(text: string, max = MAX_PAGE_CHARS): string {
  const clean = normalizeSpace(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return at > max * 0.8 ? cut.slice(0, at) : cut;
}

function wordPieces(clause: string, max: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of clause.split(" ")) {
    for (let start = 0; start < word.length; start += max) {
      const part = word.slice(start, start + max);
      if (!current) current = part;
      else if (current.length + 1 + part.length <= max) current += ` ${part}`;
      else {
        pieces.push(current);
        current = part;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function units(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  return sentence.split(/(?<=[,;:])\s+/).flatMap((clause) => (clause.length <= max ? [clause] : wordPieces(clause, max)));
}

export function chunkForSpeech(text: string, max = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const sentence of normalizeSpace(text).split(/(?<=[.!?])\s+/).flatMap((part) => units(part.trim(), max))) {
    if (!sentence) continue;
    if (!current) current = sentence;
    else if (current.length + 1 + sentence.length <= max) current += ` ${sentence}`;
    else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
