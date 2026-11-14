import { load, save, type StoredState } from "./storage.js";

const MAX_LINE = 140;

type Memory = Pick<StoredState, "profile" | "pendingMemory">;

export interface MemoryDecision extends Memory {
  saved: string[];
  proposed: string[];
}

export function normalizeMemoryLine(line: string): string {
  return line.replace(/\s+/g, " ").trim().slice(0, MAX_LINE);
}

const same = (a: string, b: string) => normalizeMemoryLine(a).toLowerCase() === normalizeMemoryLine(b).toLowerCase();

export function hasMemoryLine(lines: readonly string[], line: string): boolean {
  return lines.some((existing) => same(existing, line));
}

export function addMemoryLines(lines: readonly string[], incoming: readonly string[]): string[] {
  const next = [...lines];
  for (const raw of incoming) {
    const line = normalizeMemoryLine(raw);
    if (line && !hasMemoryLine(next, line)) next.push(line);
  }
  return next;
}

const removeMemoryLine = (lines: readonly string[], line: string) => lines.filter((existing) => !same(existing, line));

// With askBeforeRemember on, new lines wait in pendingMemory until accepted; otherwise they go straight to the profile.
export function receiveMemory(state: Memory & { askBeforeRemember: boolean }, incoming: readonly string[]): MemoryDecision {
  const fresh = addMemoryLines([], incoming).filter((line) => !hasMemoryLine(state.profile, line) && !hasMemoryLine(state.pendingMemory, line));
  if (state.askBeforeRemember) {
    return { profile: [...state.profile], pendingMemory: addMemoryLines(state.pendingMemory, fresh), saved: [], proposed: fresh };
  }
  return { profile: addMemoryLines(state.profile, fresh), pendingMemory: [...state.pendingMemory], saved: fresh, proposed: [] };
}

export function acceptMemory(state: Memory, line: string): Memory {
  return { profile: addMemoryLines(state.profile, [line]), pendingMemory: removeMemoryLine(state.pendingMemory, line) };
}

export function rejectMemory(state: Memory, line: string): Memory {
  return { ...state, pendingMemory: removeMemoryLine(state.pendingMemory, line) };
}

export function forgetMemory(state: Memory, line: string): Memory {
  return { ...state, profile: removeMemoryLine(state.profile, line) };
}

export function editMemoryLine(lines: readonly string[], index: number, next: string): string[] {
  const line = normalizeMemoryLine(next);
  const rest = lines.filter((_, i) => i !== index);
  if (!line || hasMemoryLine(rest, line)) return rest;
  return lines.map((existing, i) => (i === index ? line : existing));
}

async function update(change: (state: StoredState) => Partial<Memory>) {
  const state = await load();
  await save(change(state));
}

export async function rememberLines(lines: string[]) {
  const state = await load();
  const decision = receiveMemory(state, lines);
  await save({ profile: decision.profile, pendingMemory: decision.pendingMemory });
  return { saved: decision.saved, proposed: decision.proposed };
}

export const acceptProposal = (line: string) => update((state) => acceptMemory(state, line));
export const rejectProposal = (line: string) => update((state) => rejectMemory(state, line));
export const forgetLine = (line: string) => update((state) => forgetMemory(state, line));
export const addLine = (line: string) => update((state) => ({ profile: addMemoryLines(state.profile, [line]) }));
export const editLine = (index: number, next: string) => update((state) => ({ profile: editMemoryLine(state.profile, index, next) }));
export const clearAllMemory = () => update(() => ({ profile: [], pendingMemory: [] }));
