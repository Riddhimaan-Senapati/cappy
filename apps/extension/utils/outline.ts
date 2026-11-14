export const PAGE_TEXT_MAX = 6000;

export function buildPageText(visibleText: string, allText: string): string {
  return `${visibleText} ${allText}`.replace(/\s+/g, " ").trim().slice(0, PAGE_TEXT_MAX);
}
