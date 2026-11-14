import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyStopMotion } from "./stop-motion";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  delete (document as Partial<Document>).getAnimations;
});

const cfg = (pauseMedia: boolean) => ({ block: "stop_motion" as const, pauseMedia });

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("stop motion: media", () => {
  test("removes autoplay and loop, and undo restores them without resuming playback", () => {
    document.body.innerHTML = `<video autoplay loop src="a.mp4"></video><audio src="b.mp3"></audio>`;
    const video = document.querySelector("video")!;
    const audio = document.querySelector("audio")!;

    const undo = applyStopMotion(cfg(true));
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(video.hasAttribute("loop")).toBe(false);
    expect(audio.hasAttribute("autoplay")).toBe(false);

    undo();
    expect(video.getAttribute("autoplay")).toBe("");
    expect(video.getAttribute("loop")).toBe("");
    expect(video.hasAttribute("src")).toBe(true);
    expect(audio.hasAttribute("autoplay")).toBe(false);
  });

  test("media inserted while active is quieted until undo", async () => {
    document.body.innerHTML = "";
    const undo = applyStopMotion(cfg(true));
    const late = document.createElement("video");
    late.setAttribute("autoplay", "");
    document.body.appendChild(late);
    await nextTick();
    expect(late.hasAttribute("autoplay")).toBe(false);

    undo();
    late.setAttribute("autoplay", "");
    document.body.appendChild(document.createElement("video"));
    await nextTick();
    expect(late.getAttribute("autoplay")).toBe("");
  });

  test("pauseMedia false leaves media attributes alone", () => {
    document.body.innerHTML = `<video autoplay loop></video>`;
    const undo = applyStopMotion(cfg(false));
    expect(document.querySelector("video")!.hasAttribute("autoplay")).toBe(true);
    undo();
  });
});

describe("stop motion: animations", () => {
  test("pauses running animations and resumes only the ones it paused", () => {
    const calls: string[] = [];
    const make = (name: string, playState: string) => ({
      playState,
      pause() {
        calls.push(`pause ${name}`);
        this.playState = "paused";
      },
      play() {
        calls.push(`play ${name}`);
        this.playState = "running";
      },
    });
    const running = make("running", "running");
    const finished = make("finished", "finished");
    (document as Document).getAnimations = () => [running, finished] as unknown as Animation[];

    const undo = applyStopMotion(cfg(false));
    expect(calls).toEqual(["pause running"]);

    undo();
    expect(calls).toEqual(["pause running", "play running"]);
  });

  test("a document without the Animations API is skipped", () => {
    const undo = applyStopMotion(cfg(false));
    undo();
    undo();
  });
});
