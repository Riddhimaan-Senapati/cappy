import { describe, expect, test } from "bun:test";
import { Adaptation, ContentFilter, Rule, type Schedule } from "@browser-agent/shared";
import {
  addRulesFromAdaptation,
  nextActiveAt,
  parseRules,
  removeRule,
  rulesForHost,
  toggleRule,
} from "./rules";

const podcastFilter = ContentFilter.parse({
  keywords: ["podcast", "podcasts", "episode"],
  action: "hide",
  schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
});

function adaptation(filters: unknown[]) {
  return Adaptation.parse({
    id: "a1",
    sites: ["youtube.com"],
    reason: { text: "hide podcasts", needId: "n1" },
    blocks: [],
    filters,
  });
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return Rule.parse({
    id: "r1",
    text: "hide podcasts",
    sites: ["localhost"],
    everywhere: false,
    filter: podcastFilter,
    enabled: true,
    createdAt: 1,
    ...overrides,
  });
}

describe("parseRules", () => {
  test("drops invalid entries and keeps valid ones", () => {
    const valid = rule();
    const parsed = parseRules([valid, { id: "broken" }, "nope", null]);
    expect(parsed).toEqual([valid]);
  });

  test("a non-array value yields no rules", () => {
    expect(parseRules(undefined)).toEqual([]);
    expect(parseRules({ id: "r1" })).toEqual([]);
  });
});

describe("rulesForHost", () => {
  test("returns the enabled rules for the host or everywhere", () => {
    const local = rule();
    const everywhere = rule({ id: "r2", sites: [], everywhere: true });
    const other = rule({ id: "r3", sites: ["example.com"] });
    const off = rule({ id: "r4", enabled: false });
    expect(rulesForHost([local, everywhere, other, off], "localhost")).toEqual([local, everywhere]);
    expect(rulesForHost([local, everywhere, other, off], "example.com")).toEqual([everywhere, other]);
  });
});

describe("addRulesFromAdaptation", () => {
  const now = new Date(2026, 10, 14, 9, 0);

  test("each filter becomes a rule scoped to the host with the user's words", () => {
    const next = addRulesFromAdaptation([], adaptation([podcastFilter]), "youtube.com", "  remove podcasts on weekdays  ", now);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      text: "remove podcasts on weekdays",
      sites: ["youtube.com"],
      everywhere: false,
      enabled: true,
      createdAt: now.getTime(),
    });
    expect(next[0]!.filter).toEqual(podcastFilter);
  });

  test("an everywhere filter has no host list", () => {
    const everywhere = ContentFilter.parse({ keywords: ["sports"], action: "hide", everywhere: true });
    const [saved] = addRulesFromAdaptation([], adaptation([everywhere]), "news.example.com", "hide sports", now);
    expect(saved).toMatchObject({ everywhere: true, sites: [] });
  });

  test("an identical filter is not added twice and is switched back on", () => {
    const first = addRulesFromAdaptation([], adaptation([podcastFilter]), "youtube.com", "hide podcasts", now);
    const disabled = toggleRule(first, first[0]!.id);
    const again = addRulesFromAdaptation(disabled, adaptation([podcastFilter]), "youtube.com", "hide podcasts", now);
    expect(again).toHaveLength(1);
    expect(again[0]!.enabled).toBe(true);
  });

  test("a filter for another host is a different rule", () => {
    const first = addRulesFromAdaptation([], adaptation([podcastFilter]), "youtube.com", "hide podcasts", now);
    const second = addRulesFromAdaptation(first, adaptation([podcastFilter]), "music.example.com", "hide podcasts", now);
    expect(second).toHaveLength(2);
  });

  test("an adaptation without filters adds nothing", () => {
    const blockOnly = Adaptation.parse({
      id: "a2",
      sites: ["youtube.com"],
      reason: { text: "bigger text", needId: "n1" },
      blocks: [{ block: "text_scale", scale: 1.2 }],
    });
    expect(addRulesFromAdaptation([], blockOnly, "youtube.com", "bigger text", now)).toEqual([]);
  });
});

describe("toggleRule and removeRule", () => {
  test("toggle flips only the named rule and remove drops it", () => {
    const a = rule({ id: "a" });
    const b = rule({ id: "b" });
    const toggled = toggleRule([a, b], "a");
    expect(toggled.map((r) => r.enabled)).toEqual([false, true]);
    expect(removeRule(toggled, "a")).toEqual([toggled[1]!]);
  });
});

describe("nextActiveAt", () => {
  const weekdays: Schedule = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };

  test("an active schedule is active now", () => {
    const at = new Date(2026, 10, 16, 10, 0);
    expect(nextActiveAt(weekdays, at)).toEqual(at);
  });

  test("a weekend pauses until Monday 09:00", () => {
    const next = nextActiveAt(weekdays, new Date(2026, 10, 21, 10, 0));
    expect(next).toEqual(new Date(2026, 10, 23, 9, 0));
  });

  test("after closing time the next start is the next morning", () => {
    expect(nextActiveAt(weekdays, new Date(2026, 10, 16, 18, 0))).toEqual(new Date(2026, 10, 17, 9, 0));
  });

  test("a date range pauses until its start date", () => {
    const from: Schedule = { from: "2026-12-20" };
    expect(nextActiveAt(from, new Date(2026, 11, 1, 12, 0))).toEqual(new Date(2026, 11, 20, 0, 0));
  });

  test("an expired range never resumes", () => {
    expect(nextActiveAt({ until: "2026-12-15" }, new Date(2026, 11, 16, 12, 0))).toBeUndefined();
  });
});
