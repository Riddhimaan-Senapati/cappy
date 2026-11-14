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
  --spring: cubic-bezier(0.2, 0.9, 0.3, 1.12);
  --ease: cubic-bezier(0.22, 0.8, 0.3, 1);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: dark;
}
.ico { display: inline-grid; place-items: center; flex: none; }
`;

export const SETTINGS_CSS = `
.s { display: flex; flex-direction: column; gap: 14px; color: var(--text); font-size: 13px; line-height: 1.4; }
.s * { box-sizing: border-box; }
.s-status { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); }
.s-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; }
.s-dot.on { background: var(--good); box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.5); animation: s-ping 2.2s infinite; }
.s-dot.off { background: var(--bad); }
.s-dot.idle { background: rgba(255, 255, 255, 0.18); }
@keyframes s-ping { to { box-shadow: 0 0 0 7px rgba(74, 222, 128, 0); } }
.s-status b { font-weight: 600; }
.s-status small { display: block; color: var(--muted); font-size: 11.5px; }
.s-sec { display: flex; flex-direction: column; gap: 6px; }
.s-sec > h3 { margin: 0 0 2px 2px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
.s-row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 12px; background: var(--raise); border: 1px solid transparent; transition: background 0.15s; }
.s-row:hover { background: var(--raise2); }
.s-row .grow { flex: 1; min-width: 0; }
.s-row small { display: block; color: var(--muted); font-size: 11.5px; }
.s-switch { position: relative; width: 36px; height: 21px; flex: none; border-radius: 999px; border: 0; padding: 0; cursor: pointer; background: rgba(255, 255, 255, 0.16); transition: background 0.2s var(--ease); }
.s-switch::after { content: ""; position: absolute; top: 2.5px; left: 2.5px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.25s var(--spring); }
.s-switch[aria-checked="true"] { background: var(--grad); }
.s-switch[aria-checked="true"]::after { transform: translateX(15px); }
.s-switch:focus-visible, .s-btn:focus-visible, .s-seg button:focus-visible, .s-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.s-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); }
.s-seg button { all: unset; box-sizing: border-box; text-align: center; padding: 7px 0; border-radius: 9px; cursor: pointer; color: var(--muted); font-weight: 500; transition: background 0.2s var(--ease), color 0.2s; }
.s-seg button[aria-pressed="true"] { background: var(--raise2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }
.s-select { all: unset; box-sizing: border-box; max-width: 150px; padding: 6px 26px 6px 10px; border-radius: 9px; background: var(--raise2) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23a1a1af' stroke-width='1.5'/></svg>") no-repeat right 9px center; border: 1px solid var(--line); color: var(--text); cursor: pointer; font-size: 12px; }
.s-select:focus-visible { outline: 2px solid var(--accent); }
.s-select option { background: #1b1b22; color: #f4f4f7; }
.s-small { padding: 5px 11px; font-size: 12px; }
.s-acts { display: flex; align-items: center; gap: 10px; flex: none; }
.s-quiet { color: var(--faint) !important; font-weight: 500 !important; }
.s-quiet:hover { color: var(--muted) !important; }
.s-danger { color: var(--bad) !important; }
.s-on { font-size: 11.5px; font-weight: 600; color: var(--good); }
.s-active { border-color: rgba(74, 222, 128, 0.22); }
.s-error { color: var(--bad) !important; }
.s-seg4 { grid-template-columns: repeat(4, 1fr); }
.s-note { margin: 2px 4px 0; color: var(--faint); font-size: 11.5px; }
.s-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.s-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 4px 4px 10px; border-radius: 999px; background: rgba(139, 155, 255, 0.14); color: #dfe3ff; animation: s-pop 0.3s var(--spring); }
.s-x { all: unset; box-sizing: border-box; cursor: pointer; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: var(--muted); }
.s-x:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
@keyframes s-pop { from { opacity: 0; transform: scale(0.85); } }
.s-add { display: flex; gap: 6px; }
.s-add.stack { flex-direction: column; align-items: stretch; }
.s-add.stack .s-btn { align-self: flex-end; }
.s-add input { flex: 1; min-width: 0; all: unset; box-sizing: border-box; padding: 8px 12px; border-radius: 10px; background: var(--raise); border: 1px solid var(--line); color: var(--text); }
.s-add input:focus { border-color: var(--accent); }
.s-add input::placeholder { color: var(--faint); }
.s-btn { all: unset; box-sizing: border-box; cursor: pointer; padding: 8px 12px; border-radius: 10px; background: var(--raise); border: 1px solid var(--line); color: var(--text); font-weight: 500; display: inline-flex; align-items: center; gap: 8px; transition: background 0.15s; }
.s-btn:hover { background: var(--raise2); }
.s-change { padding: 9px 12px; border-radius: 12px; background: var(--raise); border-left: 2px solid var(--accent); animation: s-pop 0.3s var(--spring); }
.s-change.on { border: 2px solid #e11d48; box-shadow: 0 0 0 3px rgba(225, 29, 72, 0.22); }
.s-change .top { display: flex; align-items: center; gap: 8px; }
.s-change b { flex: 1; font-weight: 600; }
.s-change .why { margin-top: 2px; color: var(--muted); font-size: 12px; }
.s-tag { font-size: 11px; color: var(--faint); }
.s-link { all: unset; cursor: pointer; color: var(--accent); font-weight: 600; font-size: 12px; }
.s-empty { padding: 4px 4px; color: var(--faint); }
.s-foot { display: flex; gap: 8px; flex-wrap: wrap; }
@media (prefers-reduced-motion: reduce) { .s *, .s *::after { animation: none !important; transition: none !important; } }
`;

export const POPUP_CSS = `
html, body { margin: 0; background: #121217; }
body { box-sizing: border-box; width: 400px; padding: 20px; background: radial-gradient(ellipse at top left, rgba(139,155,255,0.07), transparent 45%), #121217; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f4f7; }
.pop-head { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.pop-logo { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; background: var(--grad); color: #0d0d12; }
.pop-head h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.pop-head small { display: block; color: var(--muted); font-size: 11.5px; }
`;
