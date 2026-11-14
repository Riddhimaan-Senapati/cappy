import { useCallback, useEffect, useRef, useState } from "react";
import { Message, type GestureAction } from "../../utils/messages";
import { startGestureTracking, type GestureTracking } from "../../utils/gesture/tracker";
import { KEYS, LastResult } from "../../utils/state";

const DEFAULT_STEP_PX = 400;

const LABELS: Record<GestureAction, string> = {
  scroll_down: "Scrolled down",
  scroll_up: "Scrolled up",
  back: "Went back",
};

function send(action: GestureAction) {
  void chrome.runtime.sendMessage(Message.parse({ type: "gesture", action, stepPx: DEFAULT_STEP_PX }));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function GesturePanel() {
  const [enabled, setEnabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<"off" | "loading" | "watching">("off");
  const [lastAction, setLastAction] = useState<GestureAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const autoEnabledFor = useRef<string | null>(null);

  const handleGesture = useCallback((action: GestureAction) => {
    send(action);
    setLastAction(action);
  }, []);

  useEffect(() => {
    if (!enabled || !videoRef.current) return;
    let cancelled = false;
    let tracking: GestureTracking | undefined;
    setStatus("loading");
    setError(null);
    startGestureTracking(videoRef.current, handleGesture)
      .then((next) => {
        if (cancelled) next.stop();
        else {
          tracking = next;
          setStatus("watching");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("gesture tracking failed", err);
        setError("Could not start the camera or hand model. Check camera permission and try again.");
        setStatus("off");
        setEnabled(false);
      });
    return () => {
      cancelled = true;
      tracking?.stop();
      setStatus("off");
    };
  }, [enabled, handleGesture]);

  useEffect(() => {
    const check = (raw: unknown) => {
      const parsed = LastResult.safeParse(raw);
      if (!parsed.success) return;
      const last = parsed.data;
      if (last.status !== "applied" || !last.blocks.includes("gesture_scroll")) return;
      if (autoEnabledFor.current === last.adaptationId) return;
      autoEnabledFor.current = last.adaptationId;
      setEnabled(true);
      setExpanded(true);
    };
    void chrome.storage.session.get(KEYS.last).then((stored) => check(stored[KEYS.last]));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const change = changes[KEYS.last];
      if (area === "session" && change) check(change.newValue);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === "j" || event.key === "J") handleGesture("scroll_down");
      else if (event.key === "k" || event.key === "K") handleGesture("scroll_up");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGesture]);

  const label =
    status === "loading"
      ? "Loading hand tracking..."
      : status === "watching"
        ? lastAction
          ? `Last gesture: ${LABELS[lastAction]}`
          : "Watching for a hand..."
        : "Gestures are off.";

  return (
    <details className="card gesture" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Gesture scrolling</summary>
      <p className="muted">
        Keep this side panel open while gestures are on. Raise an open palm to scroll down, a fist to scroll up, or swipe
        your hand left to go back.
      </p>
      <button type="button" aria-pressed={enabled} onClick={() => setEnabled((on) => !on)}>
        {enabled ? "Gesture scrolling on" : "Enable gesture scrolling"}
      </button>
      <video
        ref={videoRef}
        className="camera"
        muted
        playsInline
        aria-label="Camera preview for gesture scrolling"
        hidden={!enabled}
      />
      <p aria-live="polite">{label}</p>
      <p className="muted">Keys: J scrolls down, K scrolls up, when this panel has focus.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </details>
  );
}
