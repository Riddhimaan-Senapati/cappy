import {
  HostPattern,
  Rule,
  isScheduleActive,
  ruleAppliesTo,
  type Adaptation,
  type ContentFilter,
  type Schedule,
} from "@browser-agent/shared";

export const RULES_KEY = "rules";
const TEXT_MAX = 200;
const SEARCH_DAYS = 400;

export function parseRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const rules: Rule[] = [];
  for (const item of raw) {
    const parsed = Rule.safeParse(item);
    if (parsed.success) rules.push(parsed.data);
  }
  return rules;
}

export async function loadRules(): Promise<Rule[]> {
  try {
    const stored = await chrome.storage.local.get(RULES_KEY);
    return parseRules(stored[RULES_KEY]);
  } catch {
    return [];
  }
}

export async function saveRules(rules: readonly Rule[]): Promise<void> {
  await chrome.storage.local.set({ [RULES_KEY]: rules.map((rule) => Rule.parse(rule)) });
}

export function rulesForHost(rules: readonly Rule[], host: string): Rule[] {
  return rules.filter((rule) => ruleAppliesTo(rule, host));
}

// Every filter in a user-request adaptation becomes its own rule. An identical rule that already
// exists is switched back on instead of being duplicated.
export function addRulesFromAdaptation(
  rules: readonly Rule[],
  adaptation: Adaptation,
  host: string,
  requestText: string,
  now: Date,
): Rule[] {
  const next = [...rules];
  const site = HostPattern.safeParse(host);
  const text = requestText.trim().slice(0, TEXT_MAX);
  if (!text) return next;

  for (const filter of adaptation.filters ?? []) {
    const everywhere = filter.everywhere === true;
    if (!everywhere && !site.success) continue;
    const sites = everywhere || !site.success ? [] : [site.data];
    const key = signature(filter, everywhere, sites);
    const index = next.findIndex((rule) => signature(rule.filter, rule.everywhere, rule.sites) === key);
    if (index >= 0) {
      next[index] = { ...next[index]!, enabled: true };
      continue;
    }
    next.push(
      Rule.parse({
        id: crypto.randomUUID(),
        text,
        sites,
        everywhere,
        filter,
        enabled: true,
        createdAt: now.getTime(),
      }),
    );
  }
  return next;
}

export function toggleRule(rules: readonly Rule[], id: string): Rule[] {
  return rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule));
}

export function removeRule(rules: readonly Rule[], id: string): Rule[] {
  return rules.filter((rule) => rule.id !== id);
}

// The first moment at or after `from` when the schedule is active, or undefined if it never is again.
export function nextActiveAt(schedule: Schedule | undefined, from: Date): Date | undefined {
  if (isScheduleActive(schedule, from)) return from;
  const [hour, minute] = schedule?.start ? schedule.start.split(":").map(Number) : [0, 0];
  for (let day = 0; day <= SEARCH_DAYS; day++) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + day, hour, minute);
    if (candidate.getTime() <= from.getTime()) continue;
    if (isScheduleActive(schedule, candidate)) return candidate;
  }
  return undefined;
}

function signature(filter: ContentFilter, everywhere: boolean, sites: readonly string[]): string {
  const s = filter.schedule;
  return JSON.stringify([
    filter.keywords.map((k) => k.trim().toLowerCase()).sort(),
    filter.action,
    filter.itemSelector ?? null,
    [s?.days ?? null, s?.start ?? null, s?.end ?? null, s?.from ?? null, s?.until ?? null],
    everywhere,
    [...sites].sort(),
  ]);
}
