import type { TokenUsage } from "../../../shared/protocol.js";
import { h, icon } from "./dom.js";

export function usageCard(usage: TokenUsage): HTMLElement {
  const number = (value: number) => value.toLocaleString("en-US");
  const total = usage.inputTokens + usage.outputTokens;
  const metric = (label: string, value: number, tone: string) =>
    h("div", `usage-metric ${tone}`, "", [h("span", "usage-label", label), h("strong", "", number(value)), h("span", "usage-unit", "tokens")]);
  const bar = h("div", "usage-bar");
  bar.setAttribute("aria-hidden", "true");
  const input = h("span", "usage-bar-input");
  input.style.width = `${total ? usage.inputTokens / total * 100 : 50}%`;
  bar.append(input);
  const card = h("section", "usage-card", "", [
    h("div", "usage-head", "", [h("div", "usage-title", "", [icon("bolt", 15), h("h2", "", "LLM usage")]), h("span", "usage-badge", `${number(usage.calls)} ${usage.calls === 1 ? "call" : "calls"}`)]),
    h("div", "usage-metrics", "", [metric("Input", usage.inputTokens, "usage-input"), metric("Output", usage.outputTokens, "usage-output")]),
    bar,
    h("div", "usage-total", "", [h("span", "", "Total tokens"), h("b", "", number(total))]),
    h("p", "usage-note", "All-time on this browser · updates after each response. Includes suggestions and tool steps."),
  ]);
  return card;
}

export const USAGE_CSS = `
.usage-card { box-sizing: border-box; flex: none; padding: 18px; border: 1px solid rgba(139, 155, 255, 0.24); border-radius: 18px; background: radial-gradient(ellipse at 100% 0%, rgba(139, 155, 255, 0.15), transparent 65%), #191a24; color: var(--text); }
.usage-head, .usage-title, .usage-total { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.usage-title { justify-content: flex-start; color: #b5bdff; }
.usage-title h2 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--text); }
.usage-badge { padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.04); font-size: 11px; color: #c4c5d2; }
.usage-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 20px 0 16px; }
.usage-metric { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
.usage-metric + .usage-metric { border-left: 1px solid var(--line); padding-left: 18px; }
.usage-label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
.usage-label::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #9aa8ff; }
.usage-output .usage-label::before { background: #67d8c3; }
.usage-metric strong { font-size: clamp(20px, 6vw, 28px); font-weight: 600; letter-spacing: -0.04em; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.usage-unit { color: var(--muted); font-size: 10px; }
.usage-bar { display: flex; height: 4px; border-radius: 999px; overflow: hidden; background: #67d8c3; }
.usage-bar-input { background: #9aa8ff; }
.usage-total { margin-top: 12px; font-size: 11px; color: var(--muted); }
.usage-total b { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
.usage-note { margin: 12px 0 0; color: var(--muted); font-size: 10px; line-height: 1.5; }
@media (forced-colors: active) {
  .usage-card { border: 1px solid ButtonText; }
  .usage-metric + .usage-metric { border-left: 1px solid ButtonText; }
}
`;
