export interface Suggestion {
  text: string;
  covers: RegExp;
}

// covers matches the summary of an active change that already does this, so it is not suggested again.
export const SUGGESTIONS: Suggestion[] = [
  { text: "Make the text bigger and easier to read", covers: /text|font|read|enlarge|larger|bigger/i },
  { text: "Dark mode that's easy on the eyes", covers: /dark|dim|glare|invert|bright/i },
  { text: "I'm red-green colorblind", covers: /colou?r ?blind|deuteran|protan|daltoni/i },
  { text: "Stop all the flashing and animation", covers: /motion|animation|flash/i },
  { text: "Hide ads and popups", covers: /\bads?\b|popup|sponsor/i },
];
