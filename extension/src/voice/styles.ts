export const VOICE_CSS = `
.count-ring { position: absolute; inset: -5px; width: calc(100% + 10px); height: calc(100% + 10px); transform: rotate(-90deg); pointer-events: none; opacity: 0; }
.count-ring circle { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 0; }
.counting > .count-ring { opacity: 1; }
.counting > .count-ring circle { animation: count-drain var(--countdown, 1200ms) linear forwards; }
@keyframes count-drain { to { stroke-dashoffset: 100; } }
@media (prefers-reduced-motion: reduce) { .counting > .count-ring circle { animation: none; stroke-dasharray: 4 6; } }
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
