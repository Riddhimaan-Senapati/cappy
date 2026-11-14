import { test } from "node:test";
import assert from "node:assert/strict";
import { activityOverview, addRecent, addToActivity, BUCKET_MS, emptyActivity, GATE, HOUR_MS, SESSION_MS, shouldNudge, summarizeActivity } from "../extension/src/friction-log.js";
import type { FrictionEntry } from "../extension/src/storage.js";

const NOW = 1_000_000_000;

test("addRecent keeps only the last couple of minutes, at most 20 events, with lowercased hosts", () => {
  let log: FrictionEntry[] = [{ host: "old.example", kind: "zoom-in", at: NOW - GATE.recentMs - 1 }];
  log = addRecent(log, { host: "News.Example", kind: "zoom-in", at: NOW }, NOW);
  assert.deepEqual(log, [{ host: "news.example", kind: "zoom-in", at: NOW }]);
  for (let i = 0; i < 30; i++) log = addRecent(log, { host: "a.example", kind: "rage-click", at: NOW }, NOW);
  assert.equal(log.length, 20);
});

test("addToActivity buckets counts, prunes buckets past six hours, and keeps all-time totals", () => {
  let stats = emptyActivity();
  stats = addToActivity(stats, "News.Example", "zoom-in", NOW - SESSION_MS - BUCKET_MS);
  stats = addToActivity(stats, "news.example", "zoom-in", NOW);
  stats = addToActivity(stats, "news.example", "zoom-in", NOW);
  assert.equal(Object.keys(stats.buckets).length, 1);
  assert.deepEqual(stats.totals["news.example"], { "zoom-in": 3 });
});

test("summarizeActivity reports 10 minute, hour, six hour and all-time counts per kind", () => {
  let stats = emptyActivity();
  stats = addToActivity(stats, "news.example", "zoom-in", NOW - 3 * HOUR_MS);
  stats = addToActivity(stats, "news.example", "zoom-in", NOW - 30 * 60_000);
  stats = addToActivity(stats, "news.example", "zoom-in", NOW - 60_000);
  stats = addToActivity(stats, "video.example", "zoom-in", NOW - 60_000);
  stats = addToActivity(stats, "shop.example", "zoom-in", NOW - 2 * HOUR_MS);
  stats = addToActivity(stats, "news.example", "rage-click", NOW - 60_000);
  assert.deepEqual(summarizeActivity(stats, "NEWS.example", NOW), [
    { kind: "rage-click", here: 1, elsewhere: 0, sites: 1, hourHere: 1, sessionHere: 1, sessionElsewhere: 0, sessionSites: 1, totalHere: 1 },
    { kind: "zoom-in", here: 1, elsewhere: 1, sites: 2, hourHere: 2, sessionHere: 3, sessionElsewhere: 2, sessionSites: 3, totalHere: 3 },
  ]);
});

test("summarizeActivity keeps all-time totals after the six hour buckets expire", () => {
  const stats = addToActivity(emptyActivity(), "news.example", "pinch-zoom", NOW - SESSION_MS - BUCKET_MS);
  assert.deepEqual(summarizeActivity(stats, "news.example", NOW), [
    { kind: "pinch-zoom", here: 0, elsewhere: 0, sites: 0, hourHere: 0, sessionHere: 0, sessionElsewhere: 0, sessionSites: 0, totalHere: 1 },
  ]);
});

test("activityOverview counts events and sites in the last six hours", () => {
  let stats = addToActivity(emptyActivity(), "a.example", "zoom-in", NOW);
  stats = addToActivity(stats, "b.example", "missed-click", NOW);
  stats = addToActivity(stats, "b.example", "missed-click", NOW);
  assert.deepEqual(activityOverview(stats, NOW), { events: 3, sites: 2 });
});

test("shouldNudge stays quiet below the threshold", () => {
  const log: FrictionEntry[] = [{ host: "news.example", kind: "zoom-in", at: NOW - 1000 }];
  assert.equal(shouldNudge(log, "news.example", undefined, NOW), false);
});

test("shouldNudge fires at the threshold, ignores events on other hosts and events outside the recent window", () => {
  const log: FrictionEntry[] = [
    { host: "news.example", kind: "zoom-in", at: NOW - 1000 },
    { host: "NEWS.example", kind: "rage-click", at: NOW - 2000 },
    { host: "news.example", kind: "rage-click", at: NOW - GATE.recentMs - 1 },
    { host: "other.example", kind: "rage-click", at: NOW - 1000 },
  ];
  assert.equal(shouldNudge(log, "news.example", undefined, NOW), true);
  assert.equal(shouldNudge(log, "other.example", undefined, NOW), false);
});

test("shouldNudge respects the cooldown after a nudge", () => {
  const log: FrictionEntry[] = [
    { host: "news.example", kind: "zoom-in", at: NOW - 1000 },
    { host: "news.example", kind: "zoom-in", at: NOW - 500 },
  ];
  assert.equal(shouldNudge(log, "news.example", NOW - GATE.cooldownMs + 1, NOW), false);
  assert.equal(shouldNudge(log, "news.example", NOW - GATE.cooldownMs, NOW), true);
});
