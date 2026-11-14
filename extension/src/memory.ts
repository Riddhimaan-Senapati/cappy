import type { MemoryScope } from "../../shared/protocol.js";
import { load, save, type PendingSite, type StoredState } from "./storage.js";

const MAX_LINE = 140;

type Memory = Pick<StoredState, "profile" | "pendingMemory" | "pendingSites">;

export interface MemoryDecision extends Memory {
  proposed: string[];
}

// A preference saved for one website is stored as "On <host>: <line>" and only sent to the model on that host.
const SITE_LINE = /^On ([^\s:]+(?::\d+)?): (.+)$/i;

export const siteLine = (line: string, host: string) => `On ${host}: ${line}`;

export function lineSite(line: string): string | null {
  return line.match(SITE_LINE)?.[1].toLowerCase() ?? null;
}

export function profileFor(profile: readonly string[], host: string): string[] {
  const here = host.toLowerCase();
  return profile.filter((line) => {
    const site = lineSite(line);
    return !site || site === here;
  });
}

const pendingKey = (line: string) => normalizeMemoryLine(line).toLowerCase();

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

// New lines always wait in pendingMemory until the user picks this site or all sites; the host they came from is kept with them.
export function receiveMemory(state: Memory, incoming: readonly string[], origin: PendingSite): MemoryDecision {
  const fresh = addMemoryLines([], incoming).filter((line) =>
    !hasMemoryLine(state.profile, line) && !hasMemoryLine(state.profile, siteLine(line, origin.host)) && !hasMemoryLine(state.pendingMemory, line),
  );
  const pendingSites = { ...state.pendingSites };
  for (const line of fresh) pendingSites[pendingKey(line)] = origin;
  return { profile: [...state.profile], pendingMemory: addMemoryLines(state.pendingMemory, fresh), pendingSites, proposed: fresh };
}

export function pendingSite(state: Pick<StoredState, "pendingSites">, line: string): PendingSite | undefined {
  return state.pendingSites[pendingKey(line)];
}

export function acceptMemory(state: Memory, line: string, scope: MemoryScope): Memory {
  const host = pendingSite(state, line)?.host;
  const stored = scope === "site" && host ? siteLine(normalizeMemoryLine(line), host) : line;
  return dropPending({ ...state, profile: addMemoryLines(state.profile, [stored]) }, line);
}

export function rejectMemory(state: Memory, line: string): Memory {
  return dropPending(state, line);
}

function dropPending(state: Memory, line: string): Memory {
  const pendingSites = { ...state.pendingSites };
  delete pendingSites[pendingKey(line)];
  return { ...state, pendingMemory: removeMemoryLine(state.pendingMemory, line), pendingSites };
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

export async function rememberLines(lines: string[], origin: PendingSite) {
  const state = await load();
  const decision = receiveMemory(state, lines, origin);
  await save({ pendingMemory: decision.pendingMemory, pendingSites: decision.pendingSites });
  return decision.proposed;
}

export const acceptProposal = (line: string, scope: MemoryScope) => update((state) => acceptMemory(state, line, scope));
export const rejectProposal = (line: string) => update((state) => rejectMemory(state, line));
export const forgetLine = (line: string) => update((state) => forgetMemory(state, line));
export const addLine = (line: string) => update((state) => ({ profile: addMemoryLines(state.profile, [line]) }));
export const editLine = (index: number, next: string) => update((state) => ({ profile: editMemoryLine(state.profile, index, next) }));
export const clearAllMemory = () => update(() => ({ profile: [], pendingMemory: [], pendingSites: {} }));
