export const OVERLAY_CSS = `
*, *::before, *::after { box-sizing: border-box; }
.sp, .fab, .toast { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
.sp { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; color: var(--text); font-size: 13.5px; line-height: 1.4; }
.scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.22); opacity: 0; pointer-events: none; transition: opacity 0.2s var(--ease); }
.sp.open .scrim { opacity: 1; pointer-events: auto; }
.sp.open.running .scrim { opacity: 0; pointer-events: none; }

.bar { position: absolute; left: 50%; top: 20vh; width: min(560px, calc(100vw - 32px)); transform: translate(-50%, -6px) scale(0.985); opacity: 0; pointer-events: none;
  border-radius: 14px; background: rgba(20, 20, 24, 0.92); backdrop-filter: blur(28px) saturate(1.8); border: 1px solid rgba(255, 255, 255, 0.07); overflow: hidden;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 20px 50px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: opacity 0.14s var(--ease), transform 0.26s var(--spring), top 0.35s var(--ease); }
.sp.open .bar { opacity: 1; transform: translate(-50%, 0) scale(1); pointer-events: auto; }
.sp.running .bar { top: 4vh; }

.row { display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 8px 0 14px; }
.orb { position: relative; width: 14px; height: 14px; flex: none; border-radius: 50%; background: var(--grad); box-shadow: 0 0 14px rgba(139, 155, 255, 0.5); }
.orb.work { background: conic-gradient(from 0deg, #6ea8ff, #a78bfa, #f472b6, #6ea8ff); animation: spin 0.9s linear infinite; }
.orb.work::after { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: #17171c; }
.input { all: unset; flex: 1; min-width: 0; font-size: 15px; letter-spacing: -0.011em; color: var(--text); caret-color: var(--accent); }
.input::placeholder { color: rgba(255, 255, 255, 0.28); }

.pill { all: unset; flex: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px 0 7px; border-radius: 7px;
  font-size: 11.5px; font-weight: 550; color: rgba(255, 255, 255, 0.5); background: transparent; border: 1px solid rgba(255, 255, 255, 0.08); transition: color 0.15s, background 0.15s, border-color 0.15s; }
.pill:hover { color: var(--text); background: rgba(255, 255, 255, 0.09); }
.pill.pro { color: #e4d6ff; background: rgba(167, 139, 250, 0.16); border-color: rgba(167, 139, 250, 0.28); }
.pill .k { font: 600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: 0.55; margin-left: 2px; }
.pill.flip { animation: flip 0.32s var(--spring); }
.pill:focus-visible, .item:focus-visible, .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.body { border-top: 1px solid rgba(255, 255, 255, 0.05); max-height: min(50vh, 360px); overflow: auto; padding: 5px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.15) transparent; }
.body:empty { display: none; }
.sec { padding: 8px 10px 4px; font-size: 11px; font-weight: 550; color: rgba(255, 255, 255, 0.34); }
.item { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 9px; border-radius: 8px; cursor: pointer; font-size: 13px; color: rgba(255, 255, 255, 0.78); }
.item .ico { color: rgba(255, 255, 255, 0.32); }
.item .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .hint { color: rgba(255, 255, 255, 0.26); font-size: 11.5px; flex: none; }
.item.sel { background: rgba(255, 255, 255, 0.06); color: #fff; }
.item.sel .ico { color: var(--accent); }
.enter .item { animation: fade 0.22s var(--ease) both; animation-delay: calc(var(--i, 0) * 12ms); }

.run { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.ask-line { display: flex; align-items: baseline; gap: 10px; }
.ask-line .q { flex: 1; min-width: 0; color: rgba(255, 255, 255, 0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ask-line .meta { flex: none; font-size: 11.5px; color: rgba(255, 255, 255, 0.32); font-variant-numeric: tabular-nums; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.st { display: flex; align-items: center; gap: 9px; font-size: 13px; color: rgba(255, 255, 255, 0.5); }
.st .ico { width: 14px; color: rgba(255, 255, 255, 0.35); }
.st .t { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st.new { animation: fade 0.25s var(--ease) both; }
.st.out { padding-left: 23px; font-size: 12px; }
.st.out .ico { display: none; }
.st.good.out { color: rgba(74, 222, 128, 0.85); }
.st.warn.out { color: rgba(251, 191, 36, 0.85); }
.st.bad { color: rgba(248, 113, 113, 0.9); }
.st.now { color: var(--text); }
.st.now .t { background: linear-gradient(90deg, rgba(255, 255, 255, 0.45) 0%, #fff 45%, rgba(255, 255, 255, 0.45) 90%); background-size: 220% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 1.6s linear infinite; }
.spin { width: 12px; height: 12px; margin: 0 1px; flex: none; border-radius: 50%; border: 1.5px solid rgba(139, 155, 255, 0.25); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
.steps.done { padding-top: 2px; }
.fold { all: unset; align-self: flex-start; cursor: pointer; font-size: 11.5px; color: rgba(255, 255, 255, 0.34); padding: 2px 4px; margin-left: 20px; border-radius: 5px; }
.fold:hover { color: rgba(255, 255, 255, 0.7); background: rgba(255, 255, 255, 0.06); }
.fold:focus-visible { outline: 2px solid var(--accent); }
.result { display: flex; align-items: flex-start; gap: 9px; font-size: 14px; margin-top: 2px; color: var(--text); animation: fade 0.3s var(--ease); }
.result > .ico { margin-top: 1px; color: var(--good); }
.result.error > .ico { color: var(--bad); }
.result.blocked > .ico { color: var(--warn); }
.result.new > .ico svg path { stroke-dasharray: 30; stroke-dashoffset: 30; animation: draw 0.45s 0.08s var(--ease) forwards; }
.changes { display: flex; flex-direction: column; gap: 2px; margin-left: 24px; }
.chg { display: flex; align-items: baseline; gap: 8px; min-height: 26px; font-size: 12.5px; color: rgba(255, 255, 255, 0.8); transition: opacity 0.2s; }
.chg b { font-weight: 550; flex: none; }
.chg .why { flex: 1; min-width: 0; color: rgba(255, 255, 255, 0.38); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chg.gone { opacity: 0.4; text-decoration: line-through; }
.link { all: unset; flex: none; cursor: pointer; color: var(--accent); font-size: 12px; font-weight: 550; padding: 1px 4px; border-radius: 5px; }
.link:hover { background: rgba(255, 255, 255, 0.08); }
.settings { padding: 10px; }
.thread { display: flex; flex-direction: column; gap: 4px; padding: 6px 6px 8px; }
.card { border-radius: 10px; }
.card.enter { animation: rise 0.34s var(--spring) both; }
.card.active, .card.open { display: flex; flex-direction: column; gap: 10px; padding: 8px 8px 10px; }
.card.active { background: rgba(255, 255, 255, 0.025); }
.ask-line .link { flex: none; }
.stop { color: rgba(255, 255, 255, 0.42) !important; }
.stop:hover { color: var(--bad) !important; }
.quiet { color: rgba(255, 255, 255, 0.38) !important; }
.mini-card { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 9px; min-height: 30px; padding: 0 8px; border-radius: 8px; cursor: pointer; font-size: 12.5px; color: rgba(255, 255, 255, 0.55); }
.mini-card:hover { background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.8); }
.mini-card:focus-visible { outline: 2px solid var(--accent); }
.mini-card .ico { color: var(--good); }
.mini-card.error .ico { color: var(--bad); }
.mini-card.blocked .ico { color: var(--warn); }
.mini-card .q, .card.queued .q { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-card .meta { font-size: 11.5px; color: rgba(255, 255, 255, 0.3); }
.card.queued { display: flex; align-items: center; gap: 9px; min-height: 30px; padding: 0 6px 0 8px; border: 1px dashed rgba(255, 255, 255, 0.1); font-size: 12.5px; color: rgba(255, 255, 255, 0.5); }
.card.queued .next { font-size: 10px; font-weight: 650; letter-spacing: 0.07em; text-transform: uppercase; color: var(--accent); }
.x { all: unset; flex: none; cursor: pointer; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 6px; color: rgba(255, 255, 255, 0.35); }
.x:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.x:focus-visible { outline: 2px solid var(--accent); }
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(0.98); } }
.empty { padding: 14px 12px; font-size: 13px; color: rgba(255, 255, 255, 0.4); }
.hrow { height: auto; min-height: 44px; padding: 7px 10px; align-items: center; }
.hmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hmain .ht { font-size: 13px; color: rgba(255, 255, 255, 0.86); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.2s; }
.hmain .hr { font-size: 11.5px; color: rgba(255, 255, 255, 0.36); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hrow.off .ht { color: rgba(255, 255, 255, 0.42); }
.mini { position: relative; width: 26px; height: 15px; flex: none; border-radius: 999px; background: rgba(255, 255, 255, 0.14); transition: background 0.2s var(--ease); }
.mini::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: #fff; transition: transform 0.25s var(--spring); }
.mini.on { background: var(--grad); }
.mini.on::after { transform: translateX(11px); }

.hints { display: flex; gap: 14px; padding: 7px 16px 9px; font-size: 11.5px; color: rgba(255, 255, 255, 0.3); border-top: 1px solid rgba(255, 255, 255, 0.05); }
.hints[hidden] { display: none; }
.hints b { font-weight: 600; color: rgba(255, 255, 255, 0.5); }

.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483645; width: 40px; height: 40px; border-radius: 50%; padding: 0; cursor: pointer; display: grid; place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(23, 23, 28, 0.9); backdrop-filter: blur(16px); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  transform: scale(0.4); opacity: 0; pointer-events: none; transition: transform 0.4s var(--spring), opacity 0.25s; }
.fab .orb { width: 14px; height: 14px; }
.fab .orb.work::after { inset: 3px; }
.fab.show { transform: scale(1); opacity: 0.85; pointer-events: auto; }
.fab.show:hover { transform: scale(1.08); opacity: 1; }
.fab.hide { transform: scale(0.6); opacity: 0; pointer-events: none; }
.fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.toast { position: fixed; right: 20px; bottom: 72px; z-index: 2147483645; max-width: min(360px, calc(100vw - 40px)); pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; padding: 11px 12px 13px;
  border-radius: 13px; background: rgba(23, 23, 28, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.08); color: var(--text); font-size: 13px; line-height: 1.4; overflow: hidden;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.45); transform: translateY(10px); opacity: 0; transition: transform 0.35s var(--spring), opacity 0.2s; }
.toast.show { transform: none; opacity: 1; }
.toast > .ico { margin-top: 1px; color: var(--accent); }
.toast.error > .ico { color: var(--bad); }
.toast .msg { flex: 1; }
.toast .life { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--grad); opacity: 0.7; transform-origin: left; animation: life 9s linear forwards; }

@keyframes fade { from { opacity: 0; transform: translateY(3px); } }
@keyframes flip { 40% { transform: scale(0.9); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes shimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes life { to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition-duration: 0.01ms !important; } .st.now .t { color: var(--text); background: none; } .result.new > .ico svg path { stroke-dashoffset: 0 !important; } }
`;
