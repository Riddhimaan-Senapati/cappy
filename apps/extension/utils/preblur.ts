const STYLE_ID = "adaptive-agent-preblur";
const MAX_MS = 2500;

export function startPreblur(): () => void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = "body { filter: blur(6px) !important; transition: filter 150ms ease-out; }";
  (document.head ?? document.documentElement).append(style);

  let done = false;
  const timer = setTimeout(end, MAX_MS);
  function end(): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    style.remove();
  }
  return end;
}
