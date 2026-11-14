export const VOICE_CSS = `
.mic { all: unset; box-sizing: border-box; position: relative; width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 50%; cursor: pointer; color: var(--muted); background: var(--raise); border: 1px solid var(--line); transition: background 0.15s, color 0.15s; }
.mic:hover { background: var(--raise2); color: var(--text); }
.mic:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.mic[aria-pressed="true"] { color: #0d0d12; background: var(--grad); border-color: transparent; }
.mic[aria-pressed="true"]::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--accent); animation: mic-pulse 1.3s ease-out infinite; }
.mic[data-phase="stopping"]::after, .mic[data-phase="starting"]::after { animation: none; opacity: 0.35; }
@keyframes mic-pulse { from { transform: scale(0.92); opacity: 0.9; } to { transform: scale(1.35); opacity: 0; } }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) { .mic[aria-pressed="true"]::after { animation: none; } }
`;
