import { expect, test } from "bun:test";
import {
  EMPTY_STEPS,
  MAX_RUNS,
  MAX_STEPS_PER_RUN,
  MAX_STEP_TEXT,
  activeRunFor,
  appendStep,
  clipText,
  parseSteps,
  runsNewestFirst,
  withActiveRun,
  type Step,
  type StepsState,
} from "./steps";

function step(runId: string, n: number, tone: Step["tone"] = "info"): Step {
  return { id: `${runId}-${n}`, runId, at: n, tone, text: `step ${n}` };
}

function fill(state: StepsState, runId: string, count: number): StepsState {
  let next = state;
  for (let n = 0; n < count; n++) next = appendStep(next, step(runId, n));
  return next;
}

test("appendStep adds steps to their run in order", () => {
  const state = appendStep(appendStep(EMPTY_STEPS, step("r1", 1)), step("r1", 2));
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]!.steps.map((s) => s.text)).toEqual(["step 1", "step 2"]);
});

test("appendStep keeps only the newest 40 steps per run", () => {
  const state = fill(EMPTY_STEPS, "r1", MAX_STEPS_PER_RUN + 5);
  const steps = state.runs[0]!.steps;
  expect(steps).toHaveLength(MAX_STEPS_PER_RUN);
  expect(steps[0]!.id).toBe("r1-5");
  expect(steps.at(-1)!.id).toBe(`r1-${MAX_STEPS_PER_RUN + 4}`);
});

test("appendStep keeps only the last 3 runs", () => {
  let state = EMPTY_STEPS;
  for (const id of ["a", "b", "c", "d"]) state = appendStep(state, step(id, 1));
  expect(state.runs).toHaveLength(MAX_RUNS);
  expect(state.runs.map((r) => r.runId)).toEqual(["b", "c", "d"]);
});

test("runsNewestFirst lists the newest run first without mutating state", () => {
  let state = EMPTY_STEPS;
  for (const id of ["old", "mid", "new"]) state = appendStep(state, step(id, 1));
  expect(runsNewestFirst(state).map((r) => r.runId)).toEqual(["new", "mid", "old"]);
  expect(state.runs.map((r) => r.runId)).toEqual(["old", "mid", "new"]);
});

test("active run is tracked per tab", () => {
  const state = withActiveRun(withActiveRun(EMPTY_STEPS, 7, "run-7"), 9, "run-9");
  expect(activeRunFor(state, 7)).toBe("run-7");
  expect(activeRunFor(state, 9)).toBe("run-9");
  expect(activeRunFor(state, 1)).toBeUndefined();
});

test("clipText flattens whitespace and caps length at 120 characters", () => {
  expect(clipText("  a \n\n b  ")).toBe("a b");
  const long = clipText("x".repeat(500));
  expect(long.length).toBe(MAX_STEP_TEXT);
  expect(long.endsWith("…")).toBe(true);
});

test("parseSteps returns an empty state for anything malformed", () => {
  expect(parseSteps(undefined)).toEqual(EMPTY_STEPS);
  expect(parseSteps({ runs: "nope" })).toEqual(EMPTY_STEPS);
  const state = fill(EMPTY_STEPS, "r1", 2);
  expect(parseSteps(JSON.parse(JSON.stringify(state)))).toEqual(state);
});
