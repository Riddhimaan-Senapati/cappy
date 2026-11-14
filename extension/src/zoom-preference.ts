import type { Change } from "../../shared/adaptation.js";

export const LARGER_TEXT = "Prefers larger text";

export const learnedTextScale: Change = {
  id: "learned-text-scale",
  summary: "Larger text",
  reason: "You zoomed in more than once.",
  scope: "everywhere",
  css: null,
  dom: null,
  block: { name: "textScale", scale: 1.2 },
};
