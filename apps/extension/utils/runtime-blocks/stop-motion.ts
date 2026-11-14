import type { BlockOf } from "@browser-agent/shared";
import { Journal } from "./journal";

type Media = HTMLMediaElement;
type SavedAttrs = { autoplay: string | null; loop: string | null };

const MEDIA = "video, audio";

export function applyStopMotion(cfg: BlockOf<"stop_motion">, doc: Document = document): () => void {
  const journal = new Journal();
  try {
    pauseAnimations(doc, journal);
    if (cfg.pauseMedia) quietMedia(doc, journal);
  } catch (err) {
    journal.unwind();
    throw err;
  }
  return () => journal.unwind();
}

function pauseAnimations(doc: Document, journal: Journal): void {
  if (typeof doc.getAnimations !== "function") return;
  const paused = doc.getAnimations().filter((animation) => animation.playState === "running");
  for (const animation of paused) animation.pause();
  journal.add(() => {
    for (const animation of paused) {
      if (animation.playState === "paused") animation.play();
    }
  });
}

// Autoplay and loop are removed rather than paused only: a loop or autoplay re-arms on the next load,
// and the mutation observer must catch media the page inserts later.
function quietMedia(doc: Document, journal: Journal): void {
  const saved = new Map<Media, SavedAttrs>();
  const quiet = (media: Media): void => {
    if (!saved.has(media)) {
      saved.set(media, { autoplay: media.getAttribute("autoplay"), loop: media.getAttribute("loop") });
    }
    media.removeAttribute("autoplay");
    media.removeAttribute("loop");
    if (!media.paused) media.pause();
  };

  doc.querySelectorAll<Media>(MEDIA).forEach(quiet);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.matches(MEDIA)) quiet(el as Media);
        el.querySelectorAll<Media>(MEDIA).forEach(quiet);
      }
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  journal.add(() => {
    observer.disconnect();
    for (const [media, attrs] of saved) {
      restoreAttribute(media, "autoplay", attrs.autoplay);
      restoreAttribute(media, "loop", attrs.loop);
    }
  });
}

function restoreAttribute(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}
