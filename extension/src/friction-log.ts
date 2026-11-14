import type { FrictionCount, FrictionKind } from "../../shared/protocol.js";
import { load, save, type ActivityStats, type FrictionCounts, type FrictionEntry } from "./storage.js";

export const BUCKET_MS = 5 * 60_000;
export const RECENT_MS = 10 * 60_000;
export const HOUR_MS = 60 * 60_000;
export const SESSION_MS = 6 * HOUR_MS;
export const GATE = { recentMs: 120_000, minEvents: 2, cooldownMs: 5 * 60_000 };

const RECENT_MAX = 20;
const MAX_TOTAL_HOSTS = 200;
const NUDGE_KEEP_MS = 24 * HOUR_MS;

export const emptyActivity = (): ActivityStats => ({ buckets: {}, totals: {} });

const bump = (counts: FrictionCounts | undefined, kind: FrictionKind): FrictionCounts => ({ ...counts, [kind]: (counts?.[kind] ?? 0) + 1 });

// Only the last couple of minutes stay as raw events, for the trigger gate.
export function addRecent(log: FrictionEntry[], entry: FrictionEntry, now: number): FrictionEntry[] {
  return [...log, { ...entry, host: entry.host.toLowerCase() }].filter((item) => now - item.at <= GATE.recentMs).slice(-RECENT_MAX);
}

export function addToActivity(stats: ActivityStats, host: string, kind: FrictionKind, now: number): ActivityStats {
  const target = host.toLowerCase();
  const key = String(Math.floor(now / BUCKET_MS) * BUCKET_MS);
  const buckets: ActivityStats["buckets"] = {};
  for (const [start, hosts] of Object.entries(stats.buckets)) if (now - Number(start) < SESSION_MS) buckets[start] = hosts;
  buckets[key] = { ...buckets[key], [target]: bump(buckets[key]?.[target], kind) };
  const totals = { ...stats.totals, [target]: bump(stats.totals[target], kind) };
  const hosts = Object.keys(totals);
  if (hosts.length > MAX_TOTAL_HOSTS) {
    const sum = (counts: FrictionCounts) => Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
    for (const old of hosts.filter((name) => name !== target).sort((a, b) => sum(totals[a]) - sum(totals[b])).slice(0, hosts.length - MAX_TOTAL_HOSTS)) delete totals[old];
  }
  return { buckets, totals };
}

export function summarizeActivity(stats: ActivityStats, host: string, now: number): FrictionCount[] {
  const target = host.toLowerCase();
  const byKind = new Map<FrictionKind, FrictionCount & { recentHosts: Set<string>; sessionHosts: Set<string> }>();
  const entry = (kind: FrictionKind) => {
    let counts = byKind.get(kind);
    if (!counts) {
      counts = { kind, here: 0, elsewhere: 0, sites: 0, hourHere: 0, sessionHere: 0, sessionElsewhere: 0, sessionSites: 0, totalHere: 0, recentHosts: new Set(), sessionHosts: new Set() };
      byKind.set(kind, counts);
    }
    return counts;
  };
  for (const [start, hosts] of Object.entries(stats.buckets)) {
    const age = now - Number(start);
    if (age >= SESSION_MS) continue;
    for (const [name, kinds] of Object.entries(hosts)) {
      for (const [kind, count = 0] of Object.entries(kinds) as Array<[FrictionKind, number | undefined]>) {
        if (!count) continue;
        const counts = entry(kind);
        const here = name === target;
        counts.sessionHosts.add(name);
        if (here) counts.sessionHere += count;
        else counts.sessionElsewhere += count;
        if (here && age < HOUR_MS) counts.hourHere += count;
        if (age < RECENT_MS) {
          counts.recentHosts.add(name);
          if (here) counts.here += count;
          else counts.elsewhere += count;
        }
      }
    }
  }
  for (const [kind, count = 0] of Object.entries(stats.totals[target] ?? {}) as Array<[FrictionKind, number | undefined]>) {
    if (count) entry(kind).totalHere = count;
  }
  return [...byKind.values()]
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .map(({ recentHosts, sessionHosts, ...counts }) => ({ ...counts, sites: recentHosts.size, sessionSites: sessionHosts.size }));
}

export function activityOverview(stats: ActivityStats, now: number): { events: number; sites: number } {
  const sites = new Set<string>();
  let events = 0;
  for (const [start, hosts] of Object.entries(stats.buckets)) {
    if (now - Number(start) >= SESSION_MS) continue;
    for (const [name, kinds] of Object.entries(hosts)) {
      sites.add(name);
      events += Object.values(kinds).reduce((total, count) => total + (count ?? 0), 0);
    }
  }
  return { events, sites: sites.size };
}

export function shouldNudge(log: FrictionEntry[], host: string, nudgedAt: number | undefined, now: number): boolean {
  const target = host.toLowerCase();
  const recent = log.filter((entry) => entry.host.toLowerCase() === target && now - entry.at <= GATE.recentMs).length;
  if (recent < GATE.minEvents) return false;
  return nudgedAt === undefined || now - nudgedAt >= GATE.cooldownMs;
}

let writes: Promise<unknown> = Promise.resolve();

// Events often arrive a millisecond apart (two zoom steps); serializing the read-modify-write keeps both.
export function recordFriction(host: string, kind: FrictionKind, now = Date.now()): Promise<{ summary: FrictionCount[]; nudge: boolean }> {
  const result = writes.then(() => writeFriction(host, kind, now));
  writes = result.catch(() => undefined);
  return result;
}

async function writeFriction(host: string, kind: FrictionKind, now: number): Promise<{ summary: FrictionCount[]; nudge: boolean }> {
  const target = host.toLowerCase();
  const state = await load();
  const frictionLog = addRecent(state.frictionLog, { host: target, kind, at: now }, now);
  const activity = addToActivity(state.activity ?? emptyActivity(), target, kind, now);
  const nudge = shouldNudge(frictionLog, target, state.nudgedAt[target], now);
  const nudgedAt = nudge
    ? Object.fromEntries(Object.entries({ ...state.nudgedAt, [target]: now }).filter(([, at]) => now - at <= NUDGE_KEEP_MS))
    : undefined;
  await save({ frictionLog, activity, ...(nudgedAt ? { nudgedAt } : {}) });
  return { summary: summarizeActivity(activity, target, now), nudge };
}

export async function activityFor(host: string, now = Date.now()): Promise<FrictionCount[]> {
  return summarizeActivity((await load()).activity ?? emptyActivity(), host, now);
}

export const clearActivity = () => save({ activity: emptyActivity(), frictionLog: [], nudgedAt: {}, suggestionFeedback: [] });
