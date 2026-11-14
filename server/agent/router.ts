import type { RunRequest, Tier } from "../../shared/protocol.js";

const NEEDS_FRONTIER =
  /\b(form|chart|graph|table|grid|layout|rearrange|restructure|redesign|sort|sorted|reorder|alphabetical|alphabetically|a to z|rank|menu|sidebar|dashboard|shortcut|keyboard|every site|all sites|everywhere|why|doesn't work|not working|didn't|broken)\b/i;

export function pickTier(request: RunRequest): Tier {
  if (request.routing !== "auto") return request.routing;
  if (request.trigger === "page_load") return "fast";
  if (request.trigger === "review" || request.makeItWork) return "frontier";
  const words = request.message.trim().split(/\s+/).length;
  if (words > 24 || NEEDS_FRONTIER.test(request.message)) return "frontier";
  return "fast";
}
