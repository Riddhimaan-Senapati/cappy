import { z } from "zod";
import type { Adaptation } from "@browser-agent/shared";

export const STEPS_KEY = "steps";
export const MAX_RUNS = 3;
export const MAX_STEPS_PER_RUN = 40;
export const MAX_STEP_TEXT = 120;

export const Tone = z.enum(["info", "good", "warn", "bad"]);
export type Tone = z.infer<typeof Tone>;

export const Step = z
  .object({
    id: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    at: z.number().int().nonnegative(),
    tone: Tone,
    text: z.string().max(MAX_STEP_TEXT),
  })
  .strict();
export type Step = z.infer<typeof Step>;

export const Run = z.object({ runId: z.string().min(1).max(64), steps: z.array(Step) }).strict();
export type Run = z.infer<typeof Run>;

export const StepsState = z
  .object({
    runs: z.array(Run),
    activeByTab: z.record(z.string(), z.string().min(1).max(64)),
  })
  .strict();
export type StepsState = z.infer<typeof StepsState>;

export const EMPTY_STEPS: StepsState = { runs: [], activeByTab: {} };

export function clipText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_STEP_TEXT) return flat;
  return `${flat.slice(0, MAX_STEP_TEXT - 1)}…`;
}

// Names only: the block and edit labels come from the model's own choice, never from page text.
export function describeChoice(adaptation: Adaptation): string {
  const names: string[] = adaptation.blocks.map((b) => b.block);
  if (adaptation.ops?.length) names.push(`${adaptation.ops.length} page edit${adaptation.ops.length === 1 ? "" : "s"}`);
  return names.length > 0 ? names.join(", ") : "page styles";
}

export function parseSteps(raw: unknown): StepsState {
  const parsed = StepsState.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_STEPS;
}

// Runs are stored oldest first; appending a step to an unknown run starts that run.
export function appendStep(state: StepsState, step: Step): StepsState {
  const index = state.runs.findIndex((run) => run.runId === step.runId);
  let runs: Run[];
  if (index === -1) {
    runs = [...state.runs, { runId: step.runId, steps: [step] }].slice(-MAX_RUNS);
  } else {
    runs = state.runs.map((run, i) =>
      i === index ? { ...run, steps: [...run.steps, step].slice(-MAX_STEPS_PER_RUN) } : run,
    );
  }
  return { ...state, runs };
}

export function runsNewestFirst(state: StepsState): Run[] {
  return [...state.runs].reverse();
}

export function withActiveRun(state: StepsState, tabId: number, runId: string): StepsState {
  return { ...state, activeByTab: { ...state.activeByTab, [String(tabId)]: runId } };
}

export function activeRunFor(state: StepsState, tabId: number): string | undefined {
  return state.activeByTab[String(tabId)];
}

let queue: Promise<unknown> = Promise.resolve();

// Serialized so two tabs logging at once cannot overwrite each other's steps.
function mutate<T>(change: (state: StepsState) => { state: StepsState; result: T }): Promise<T> {
  const run = queue.then(async () => {
    const stored = await chrome.storage.session.get(STEPS_KEY);
    const { state, result } = change(parseSteps(stored[STEPS_KEY]));
    await chrome.storage.session.set({ [STEPS_KEY]: state });
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function readSteps(): Promise<StepsState> {
  const stored = await chrome.storage.session.get(STEPS_KEY);
  return parseSteps(stored[STEPS_KEY]);
}

export async function startRun(tabId: number): Promise<string> {
  const runId = crypto.randomUUID();
  await mutate((state) => ({ state: withActiveRun(state, tabId, runId), result: runId }));
  return runId;
}

export async function logStep(runId: string, tone: Tone, text: string): Promise<void> {
  const step: Step = {
    id: crypto.randomUUID(),
    runId,
    at: Date.now(),
    tone,
    text: clipText(text),
  };
  await mutate((state) => ({ state: appendStep(state, step), result: undefined }));
}

// Phases log against the tab's current run so they need no run id threaded through.
export async function logForTab(tabId: number, tone: Tone, text: string): Promise<void> {
  try {
    const state = await readSteps();
    const runId = activeRunFor(state, tabId) ?? (await startRun(tabId));
    await logStep(runId, tone, text);
  } catch (err) {
    console.warn("could not log step", err);
  }
}
