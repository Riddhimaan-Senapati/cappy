// "Point and speak": which element, if any, a spoken request is about.
export interface PointedCandidate<T> {
  value: T;
  // The camera air pointer is a deliberate gesture; the mouse resting somewhere is not.
  deliberate: boolean;
}

const DEICTIC = /\b(this|that|these|those|here|it|them)\b/i;

export const mentionsTarget = (text: string) => DEICTIC.test(text);

// Prefer what the user pointed at when they started speaking, then what they point at when they finish.
export function chooseTarget<T>(text: string, atStart: PointedCandidate<T> | null, atEnd: PointedCandidate<T> | null): T | null {
  const deictic = mentionsTarget(text);
  for (const candidate of [atStart, atEnd]) {
    if (candidate && (candidate.deliberate || deictic)) return candidate.value;
  }
  return null;
}
