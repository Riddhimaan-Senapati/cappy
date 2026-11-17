export const TOKENS = `
:host, :root {
  --bg: rgba(18, 18, 23, 0.93);
  --solid: #121217;
  --raise: rgba(255, 255, 255, 0.05);
  --raise2: rgba(255, 255, 255, 0.09);
  --line: rgba(255, 255, 255, 0.09);
  --text: #f4f4f7;
  --muted: #a1a1af;
  --faint: #70707e;
  --accent: #8b9bff;
  --good: #4ade80;
  --warn: #fbbf24;
  --bad: #f87171;
  --grad: linear-gradient(135deg, #6ea8ff 0%, #a78bfa 55%, #f472b6 100%);
  --ink: 255, 255, 255;
  --strong: #fff;
  --panel: rgba(20, 20, 24, 0.92);
  --panel-solid: #17171d;
  --accent-text: #dfe3ff;
  --pro-text: #e4d6ff;
  --spring: cubic-bezier(0.2, 0.9, 0.3, 1.12);
  --ease: cubic-bezier(0.22, 0.8, 0.3, 1);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: dark;
}
:host([data-theme="light"]), :root[data-theme="light"] {
  --bg: rgba(255, 255, 255, 0.95);
  --solid: #ffffff;
  --raise: rgba(20, 20, 35, 0.045);
  --raise2: rgba(20, 20, 35, 0.08);
  --line: rgba(20, 20, 35, 0.11);
  --text: #17171f;
  --muted: #5d5d6e;
  --faint: #8b8b9a;
  --accent: #4555e8;
  --good: #177a3b;
  --warn: #a35a06;
  --bad: #c42424;
  --ink: 20, 20, 35;
  --strong: #0b0b12;
  --panel: rgba(250, 250, 252, 0.95);
  --panel-solid: #f2f2f6;
  --accent-text: #3442c9;
  --pro-text: #6d28d9;
  color-scheme: light;
}
.ico { display: inline-grid; place-items: center; flex: none; }
@media (prefers-contrast: more) {
  :host, :root { --line: rgba(255, 255, 255, 0.32); --raise: rgba(255, 255, 255, 0.09); }
  :host([data-theme="light"]), :root[data-theme="light"] { --line: rgba(20, 20, 35, 0.45); --raise: rgba(20, 20, 35, 0.07); }
}
`;

export const SETTINGS_CSS = `
.s { display: flex; flex-direction: column; gap: 14px; color: var(--text); font-size: 13px; line-height: 1.4; }
.s * { box-sizing: border-box; }
.s-status { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); }
.s-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; }
.s-dot.on { background: var(--good); box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.5); animation: s-ping 2.2s infinite; }
.s-dot.off { background: var(--bad); }
.s-dot.idle { background: rgba(var(--ink), 0.18); }
@keyframes s-ping { to { box-shadow: 0 0 0 7px rgba(74, 222, 128, 0); } }
.s-status b { font-weight: 600; }
.s-status small { display: block; color: var(--muted); font-size: 11.5px; }
.s-status .grow { flex: 1; min-width: 0; }
.s-status .grow small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s-status .s-power { font-size: 11px; font-weight: 600; color: var(--muted); }
.s-tabs { position: sticky; top: 0; z-index: 1; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; padding: 3px; border-radius: 12px; background: var(--panel-solid); border: 1px solid var(--line); }
.s-tabs button { all: unset; box-sizing: border-box; min-height: 24px; text-align: center; padding: 7px 0; border-radius: 9px; cursor: pointer; color: var(--muted); font-weight: 500; font-size: 12.5px; transition: background 0.2s var(--ease), color 0.2s; }
.s-tabs button:hover { color: var(--text); }
.s-tabs button[aria-selected="true"] { background: var(--raise2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }
.s-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.s-panel { display: flex; flex-direction: column; gap: 16px; animation: s-fade 0.25s var(--ease); }
@keyframes s-fade { from { opacity: 0; transform: translateY(4px); } }
.s-more { border-radius: 12px; }
.s-more > summary { cursor: pointer; list-style: none; min-height: 24px; display: flex; align-items: center; padding: 6px 4px; color: var(--muted); font-size: 12px; font-weight: 500; }
.s-more > summary::-webkit-details-marker { display: none; }
.s-more > summary::before { content: "›"; display: inline-block; width: 12px; transition: transform 0.2s var(--ease); }
.s-more[open] > summary::before { transform: rotate(90deg); }
.s-more > summary:hover { color: var(--text); }
.s-more > summary:focus-visible { outline: 2px solid var(--accent); border-radius: 8px; }
.s-more[open] { display: flex; flex-direction: column; gap: 6px; }
.s-links { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
.s-chipbtn { all: unset; box-sizing: border-box; cursor: pointer; min-height: 24px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--raise); color: var(--muted); font-size: 12px; font-weight: 500; transition: background 0.15s, color 0.15s, border-color 0.15s; }
.s-chipbtn:hover { background: var(--raise2); color: var(--text); border-color: rgba(var(--ink), 0.16); }
.s-chipbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.s-danger-btn { color: var(--bad) !important; border-color: rgba(248, 113, 113, 0.35) !important; }
.s-danger-btn:hover { background: rgba(248, 113, 113, 0.12) !important; }
.s-warn { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: rgba(248, 113, 113, 0.08); border: 1px solid rgba(248, 113, 113, 0.3); animation: s-pop 0.25s var(--spring); }
.s-warn b { color: var(--text); font-weight: 600; }
.s-warn p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.s-warn .s-acts { justify-content: flex-end; }
.s-row .s-link { flex: none; }
.s-stats { display: grid; grid-template-columns: repeat(3, 1fr); border-radius: 12px; background: var(--raise); overflow: hidden; }
.s-stat { display: flex; flex-direction: column; gap: 1px; padding: 11px 12px; }
.s-stat + .s-stat { border-left: 1px solid var(--line); }
.s-stat b { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.s-stat small { color: var(--muted); font-size: 11.5px; }
.s-empty code { font-size: 11.5px; padding: 1px 6px; border-radius: 6px; background: rgba(var(--ink),0.08); }
.s-sec { display: flex; flex-direction: column; gap: 6px; }
.s-sec > h3 { margin: 0 0 2px 2px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.s-row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 12px; background: var(--raise); border: 1px solid transparent; transition: background 0.15s; }
.s-row:hover { background: var(--raise2); }
.s-row .grow { flex: 1; min-width: 0; }
.s-row small { display: block; color: var(--muted); font-size: 11.5px; }
.s-switch { position: relative; width: 36px; height: 24px; flex: none; border: 0; padding: 0; cursor: pointer; background: transparent; }
.s-switch::before { content: ""; position: absolute; left: 0; right: 0; top: 1.5px; height: 21px; border-radius: 999px; background: rgba(var(--ink), 0.16); transition: background 0.2s var(--ease); }
.s-switch::after { content: ""; position: absolute; top: 4px; left: 2.5px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.25s var(--spring); }
.s-switch[aria-checked="true"]::before { background: var(--grad); }
.s-switch[aria-checked="true"]::after { transform: translateX(15px); }
.s-switch:focus-visible, .s-btn:focus-visible, .s-seg button:focus-visible, .s-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.s-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); }
.s-seg button { all: unset; box-sizing: border-box; min-height: 24px; text-align: center; padding: 7px 0; border-radius: 9px; cursor: pointer; color: var(--muted); font-weight: 500; transition: background 0.2s var(--ease), color 0.2s; }
.s-seg button[aria-pressed="true"] { background: var(--raise2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }
.s-select { all: unset; box-sizing: border-box; min-height: 24px; max-width: 150px; padding: 6px 26px 6px 10px; border-radius: 9px; background: var(--raise2) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23a1a1af' stroke-width='1.5'/></svg>") no-repeat right 9px center; border: 1px solid var(--line); color: var(--text); cursor: pointer; font-size: 12px; }
.s-select:focus-visible { outline: 2px solid var(--accent); }
.s-select option { background: var(--panel-solid); color: var(--text); }
.s-small { padding: 5px 11px; font-size: 12px; }
.s-acts { display: flex; align-items: center; gap: 10px; flex: none; }
.s-quiet { color: var(--muted) !important; font-weight: 500 !important; }
.s-quiet:hover { color: var(--text) !important; }
.s-danger { color: var(--bad) !important; }
.s-on { font-size: 11.5px; font-weight: 600; color: var(--good); }
.s-active { border-color: rgba(74, 222, 128, 0.22); }
.s-error { color: var(--bad) !important; }
.s-seg4 { grid-template-columns: repeat(4, 1fr); }
.s-note { margin: 2px 4px 0; color: var(--muted); font-size: 11.5px; }
.s-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.s-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 4px 4px 10px; border-radius: 999px; background: rgba(139, 155, 255, 0.14); color: var(--accent-text); animation: s-pop 0.3s var(--spring); }
.s-x { all: unset; box-sizing: border-box; cursor: pointer; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; color: var(--muted); }
.s-x:hover { background: rgba(var(--ink), 0.14); color: var(--strong); }
@keyframes s-pop { from { opacity: 0; transform: scale(0.85); } }
.s-add { display: flex; gap: 6px; }
.s-add.stack { flex-direction: column; align-items: stretch; }
.s-add.stack .s-btn { align-self: flex-end; }
.s-add input { flex: 1; min-width: 0; all: unset; box-sizing: border-box; padding: 8px 12px; border-radius: 10px; background: var(--raise); border: 1px solid var(--line); color: var(--text); }
.s-add input:focus { border-color: var(--accent); }
.s-add input::placeholder { color: var(--muted); }
.s-btn { all: unset; box-sizing: border-box; cursor: pointer; min-height: 24px; padding: 8px 12px; border-radius: 10px; background: var(--raise); border: 1px solid var(--line); color: var(--text); font-weight: 500; display: inline-flex; align-items: center; gap: 8px; transition: background 0.15s; }
.s-btn:hover { background: var(--raise2); }
.s-change { padding: 9px 12px; border-radius: 12px; background: var(--raise); border-left: 2px solid var(--accent); animation: s-pop 0.3s var(--spring); }
.s-change.on { border: 2px solid #e11d48; box-shadow: 0 0 0 3px rgba(225, 29, 72, 0.22); }
.s-change .top { display: flex; align-items: center; gap: 8px; }
.s-change b { flex: 1; font-weight: 600; }
.s-change .why { margin-top: 2px; color: var(--muted); font-size: 12px; }
.s-tag { font-size: 11px; color: var(--muted); }
.s-link { all: unset; box-sizing: border-box; cursor: pointer; min-height: 24px; display: inline-flex; align-items: center; color: var(--accent); font-weight: 600; font-size: 12px; }
.s-empty { padding: 4px 4px; color: var(--muted); }
.s-foot { display: flex; gap: 8px; flex-wrap: wrap; }
.s input[type="range"] { height: 24px; accent-color: var(--accent); }
@media (prefers-reduced-motion: reduce) { .s *, .s *::after { animation: none !important; transition: none !important; } }
@media (forced-colors: active) {
  .s button:focus-visible, .s input:focus-visible, .s select:focus-visible, .s summary:focus-visible, .s-x:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  .s-btn, .s-chipbtn, .s-select, .s-add input, .s-seg, .s-x { border: 1px solid ButtonText; }
  .s-seg button, .s-tabs button { border: 1px solid transparent; }
  .s-seg button[aria-pressed="true"], .s-tabs button[aria-selected="true"] { border: 1px solid ButtonText; text-decoration: underline; }
  .s-switch::before { background: ButtonFace; border: 1px solid ButtonText; }
  .s-switch[aria-checked="true"]::before { background: Highlight; border-color: Highlight; }
  .s-switch::after { background: ButtonText; }
  .s-switch[aria-checked="true"]::after { background: ButtonFace; }
  .s-dot { border: 1px solid CanvasText; }
  .s-link, .s-more > summary { text-decoration: underline; }
  .s-danger-btn, .s-error { text-decoration: underline; }
}
`;
