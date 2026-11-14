import type { ThinkingLevel } from "@google/genai";
import { geminiAdapter } from "../apps/backend/src/gemini-adapter";
import { guardAdaptResponse } from "../apps/backend/src/guard";
import type { AdaptRequest } from "@browser-agent/shared";

const key = (await Bun.file(new URL("../.env", import.meta.url)).text()).match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("GEMINI_API_KEY missing from .env");

const models = process.argv.slice(2);
const RUNS = 3;

const req = {
  url: "https://www.w3.org/WAI/demos/bad/before/survey.html",
  outline: { title: "Survey - Inaccessible Version", headings: ["Survey", "Personal data", "Your experience"], forms: 1, images: 4, videos: 0, canvases: 0 },
  profile: {
    version: 1,
    summary: "Student with red-green colorblindness, light sensitivity, prefers larger text, temporary wrist injury.",
    needs: [
      { id: "n1", kind: "color_vision", detail: "red-green colorblind (deuteranopia)", source: "onboarding" },
      { id: "n2", kind: "text_size", detail: "prefers larger text", source: "onboarding" },
      { id: "n3", kind: "motor", detail: "wrist in a cast, hard to hit small targets", source: "onboarding" },
    ],
  },
} as AdaptRequest;

for (const model of models) {
  const adapter = geminiAdapter(key, model, process.env.THINKING as ThinkingLevel | undefined);
  const times: number[] = [];
  let valid = 0;
  let sample = "";
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    try {
      const out = guardAdaptResponse(await adapter(req), "www.w3.org");
      times.push(performance.now() - t0);
      if (out.kind === "adaptation") valid++;
      sample = out.kind === "adaptation" ? out.adaptation.blocks.map((b) => b.block).join("+") : `${out.kind}: ${out.reason}`;
    } catch (e) {
      times.push(performance.now() - t0);
      sample = `error: ${(e as Error).message.slice(0, 120)}`;
    }
  }
  times.sort((a, b) => a - b);
  console.log(`${model.padEnd(24)} thinking ${process.env.THINKING ?? "default"} valid ${valid}/${RUNS}  median ${(times[1]! / 1000).toFixed(2)}s  min ${(times[0]! / 1000).toFixed(2)}s  last: ${sample}`);
}
