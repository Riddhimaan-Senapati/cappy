export const OVERLAY_CSS = `
*, *::before, *::after { box-sizing: border-box; }
.sp, .fab, .toast { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
.sp { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; color: var(--text); font-size: 14px; line-height: 1.4; }
.scrim { position: absolute; inset: 0; background: rgba(8, 8, 12, 0.5); backdrop-filter: blur(7px) saturate(1.15); opacity: 0; pointer-events: none; transition: opacity 0.28s var(--ease); }
.sp.open .scrim { opacity: 1; pointer-events: auto; }
.sp.open.running .scrim { opacity: 0; pointer-events: none; }
.bar { position: absolute; left: 50%; top: 15vh; width: min(660px, calc(100vw - 32px)); transform: translate(-50%, -12px) scale(0.965); opacity: 0; pointer-events: none;
  border-radius: 22px; background: var(--bg); backdrop-filter: blur(30px) saturate(1.5); border: 1px solid var(--line); overflow: hidden;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45), 0 34px 90px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  transition: opacity 0.18s var(--ease), transform 0.38s var(--spring), top 0.45s var(--ease); }
.sp.open .bar { opacity: 1; transform: translate(-50%, 0) scale(1); pointer-events: auto; }
.sp.running .bar { top: 5vh; }
.row { display: flex; align-items: center; gap: 14px; padding: 17px 18px 17px 20px; }
.orb { position: relative; width: 22px; height: 22px; flex: none; border-radius: 50%; background: var(--grad); box-shadow: 0 0 20px rgba(139, 155, 255, 0.55); animation: breathe 3.8s ease-in-out infinite; }
.orb.work { background: conic-gradient(from 0deg, #6ea8ff, #a78bfa, #f472b6, #6ea8ff); animation: spin 1.1s linear infinite; }
.orb.work::after { content: ""; position: absolute; inset: 5px; border-radius: 50%; background: #17171d; }
.input { all: unset; flex: 1; min-width: 0; font-size: 19px; letter-spacing: -0.012em; color: var(--text); caret-color: var(--accent); }
.input::placeholder { color: var(--faint); }
.trail { display: flex; align-items: center; gap: 6px; flex: none; }
.kbd { font: 600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 3px 7px; border-radius: 7px; background: var(--raise2); color: var(--muted); border: 1px solid var(--line); }
.back { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 9px; color: var(--muted); background: var(--raise); border: 1px solid var(--line); font-size: 12px; font-weight: 500; }
.back:hover { color: var(--text); background: var(--raise2); }
.body { border-top: 1px solid var(--line); max-height: min(54vh, 440px); overflow: auto; padding: 8px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.18) transparent; }
.body:empty { display: none; }
.sec { padding: 10px 12px 5px; font-size: 11px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--faint); }
.item { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 13px; cursor: pointer; transition: background 0.12s; }
.request-row { display: flex; align-items: center; gap: 6px; }
.request-row .delete-request { color: #f87171; }
.request-row .item { flex: 1; min-width: 0; }
.item .ico { width: 30px; height: 30px; border-radius: 10px; background: var(--raise); color: var(--muted); transition: background 0.2s, color 0.2s, transform 0.3s var(--spring); }
.item .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .hint { color: var(--faint); font-size: 12px; flex: none; }
.item.sel { background: var(--raise2); }
.item.sel .ico { background: var(--grad); color: #0d0d12; transform: scale(1.06); }
.item.ask .title { font-weight: 600; }
.enter .item { animation: rise 0.38s var(--spring) both; animation-delay: calc(var(--i, 0) * 16ms); }
.run { display: flex; flex-direction: column; gap: 12px; padding: 8px 8px 10px; }
.you { display: flex; align-items: center; gap: 10px; padding: 2px 6px; color: var(--muted); }
.you .ico { color: var(--accent); }
.steps { list-style: none; margin: 0; padding: 0 6px; display: flex; flex-direction: column; gap: 7px; }
.step { display: flex; align-items: center; gap: 11px; color: var(--muted); font-size: 13px; }
.step.new { animation: rise 0.34s var(--spring) both; }
.step::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: none; }
.steps.live .step:last-child { color: var(--text); }
.steps.live .step:last-child::before { background: var(--accent); animation: blink 0.9s infinite; }
.step.good { color: var(--good); } .step.good::before { background: var(--good); }
.step.warn { color: var(--warn); } .step.warn::before { background: var(--warn); }
.step.bad { color: var(--bad); } .step.bad::before { background: var(--bad); }
.result { display: flex; gap: 12px; align-items: flex-start; padding: 14px 15px; border-radius: 15px; background: linear-gradient(180deg, rgba(74, 222, 128, 0.11), rgba(74, 222, 128, 0.04)); border: 1px solid rgba(74, 222, 128, 0.24); }
.result.new { animation: rise 0.45s var(--spring) both; }
.result.error { background: linear-gradient(180deg, rgba(248, 113, 113, 0.12), rgba(248, 113, 113, 0.04)); border-color: rgba(248, 113, 113, 0.28); }
.result.blocked { background: linear-gradient(180deg, rgba(251, 191, 36, 0.12), rgba(251, 191, 36, 0.04)); border-color: rgba(251, 191, 36, 0.3); }
.result > .ico { width: 26px; height: 26px; border-radius: 50%; background: rgba(74, 222, 128, 0.18); color: var(--good); margin-top: 1px; }
.result.error > .ico { background: rgba(248, 113, 113, 0.18); color: var(--bad); }
.result.blocked > .ico { background: rgba(251, 191, 36, 0.18); color: var(--warn); }
.result.new > .ico svg path { stroke-dasharray: 30; stroke-dashoffset: 30; animation: draw 0.55s 0.12s var(--ease) forwards; }
.result p { margin: 0; flex: 1; font-size: 14px; }
.applied { display: flex; flex-direction: column; gap: 6px; }
.chg { padding: 10px 13px; border-radius: 13px; background: var(--raise); border: 1px solid var(--line); transition: opacity 0.25s; }
.chg.gone { opacity: 0.45; }
.chg .top { display: flex; align-items: center; gap: 9px; }
.chg .top b { flex: 1; font-weight: 600; }
.chg .tag { font-size: 11px; color: var(--faint); }
.chg .why { margin-top: 2px; color: var(--muted); font-size: 12.5px; }
.link { all: unset; cursor: pointer; color: var(--accent); font-weight: 600; font-size: 12.5px; padding: 2px 4px; border-radius: 6px; }
.link:hover { background: var(--raise2); }
.link:focus-visible, .back:focus-visible, .item:focus-visible { outline: 2px solid var(--accent); }
.settings { padding: 12px; }
.foot { display: grid; gap: 6px; padding: 9px 18px; border-top: 1px solid var(--line); background: rgba(0, 0, 0, 0.2); color: var(--faint); font-size: 12px; }
.foot .grow { flex: 1; }
.queue-actions { display: flex; align-items: center; gap: 10px; }
.queue-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-queue { max-height: 120px; overflow: auto; }
.foot .k { display: inline-flex; gap: 6px; align-items: center; }
.chip { padding: 2px 9px; border-radius: 999px; font-weight: 500; animation: pop 0.35s var(--spring); }
.chip.fast { color: #bfe3ff; background: rgba(110, 168, 255, 0.2); }
.chip.frontier { color: #ead9ff; background: rgba(167, 139, 250, 0.24); }
.fab { position: fixed; right: 22px; bottom: 22px; z-index: 2147483645; width: 46px; height: 46px; border-radius: 50%; padding: 0; cursor: pointer; display: grid; place-items: center;
  border: 1px solid var(--line); background: var(--bg); backdrop-filter: blur(18px) saturate(1.4); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  transform: scale(0.3); opacity: 0; pointer-events: none; transition: transform 0.5s var(--spring), opacity 0.3s, box-shadow 0.25s; }
.fab.show { transform: scale(1); opacity: 0.92; pointer-events: auto; }
.fab.show:hover { transform: scale(1.09); opacity: 1; box-shadow: 0 14px 40px rgba(139, 155, 255, 0.35), 0 12px 32px rgba(0, 0, 0, 0.45); }
.fab.hide { transform: scale(0.6); opacity: 0; pointer-events: none; }
.fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.toast { position: fixed; right: 22px; bottom: 82px; z-index: 2147483645; max-width: min(380px, calc(100vw - 44px)); pointer-events: auto; display: flex; align-items: flex-start; gap: 12px; padding: 14px 14px 17px 14px;
  border-radius: 18px; background: var(--bg); backdrop-filter: blur(26px) saturate(1.4); border: 1px solid var(--line); color: var(--text); font-size: 13.5px; line-height: 1.4; overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); transform: translateY(16px) scale(0.96); opacity: 0; transition: transform 0.45s var(--spring), opacity 0.25s; }
.toast.show { transform: none; opacity: 1; }
.toast.speak { bottom: 22px; right: 76px; padding: 10px 12px; align-items: center; }
.toast > .ico { width: 24px; height: 24px; border-radius: 50%; background: var(--grad); color: #0d0d12; }
.toast.error > .ico { background: rgba(248, 113, 113, 0.22); color: var(--bad); }
.toast .msg { flex: 1; padding-top: 2px; }
.toast .life { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--grad); transform-origin: left; animation: life 9s linear forwards; }
@keyframes rise { from { opacity: 0; transform: translateY(9px) scale(0.985); } }
@keyframes pop { from { opacity: 0; transform: scale(0.8); } }
@keyframes blink { 50% { opacity: 0.25; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 50% { transform: scale(0.9); box-shadow: 0 0 26px rgba(167, 139, 250, 0.65); } }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes life { to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition-duration: 0.01ms !important; } .result.new > .ico svg path { stroke-dashoffset: 0 !important; } }
`;
