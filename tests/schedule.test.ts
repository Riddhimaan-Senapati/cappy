import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addHours, addSeconds } from "date-fns";
import { describeSchedule, isOneShot, isScheduleActive, lastingRequest } from "../shared/validate.js";
import type { Change } from "../shared/adaptation.js";
import { parseSpokenSchedule, withSpokenSchedule } from "../server/agent/schedule.js";

type Schedule = NonNullable<Change["schedule"]>;
const at = (y: number, mo: number, d: number, h: number, m = 0, s = 0) => new Date(y, mo - 1, d, h, m, s);
const visibleSchedule = (schedule: Schedule | null | undefined) => ({
  days: schedule?.days ?? null,
  start: schedule?.start ?? null,
  end: schedule?.end ?? null,
  from: schedule?.from ?? null,
  until: schedule?.until ?? null,
  untilAt: schedule?.untilAt ?? null,
});

describe("isScheduleActive", () => {
  it("is always active without a schedule", () => {
    assert.equal(isScheduleActive(undefined, at(2026, 11, 14, 3)), true);
    assert.equal(isScheduleActive(null, at(2026, 11, 14, 3)), true);
  });

  it("weekdays 9 to 5 are active from 09:00 up to but not including 17:00", () => {
    const weekdays: Schedule = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };
    assert.equal(isScheduleActive(weekdays, at(2026, 11, 16, 9, 0)), true, "Monday 09:00");
    assert.equal(isScheduleActive(weekdays, at(2026, 11, 20, 16, 59)), true, "Friday 16:59");
    assert.equal(isScheduleActive(weekdays, at(2026, 11, 16, 8, 59)), false, "Monday 08:59");
    assert.equal(isScheduleActive(weekdays, at(2026, 11, 16, 17, 0)), false, "Monday 17:00");
    assert.equal(isScheduleActive(weekdays, at(2026, 11, 21, 10, 0)), false, "Saturday 10:00");
    assert.equal(isScheduleActive(weekdays, at(2026, 11, 22, 10, 0)), false, "Sunday 10:00");
  });

  it("date ranges are inclusive at both ends", () => {
    const range: Schedule = { from: "2026-11-16", until: "2026-11-18" };
    assert.equal(isScheduleActive(range, at(2026, 11, 15, 23, 59)), false);
    assert.equal(isScheduleActive(range, at(2026, 11, 16, 0, 0)), true);
    assert.equal(isScheduleActive(range, at(2026, 11, 18, 23, 59)), true);
    assert.equal(isScheduleActive(range, at(2026, 11, 19, 0, 1)), false);
  });

  it("an until date alone ends the change after that day", () => {
    const untilDec: Schedule = { until: "2026-12-15" };
    assert.equal(isScheduleActive(untilDec, at(2026, 12, 15, 23, 0)), true);
    assert.equal(isScheduleActive(untilDec, at(2026, 12, 16, 0, 0)), false);
  });

  it("overnight ranges belong to the day they start on", () => {
    const night: Schedule = { start: "22:00", end: "06:00" };
    assert.equal(isScheduleActive(night, at(2026, 11, 16, 23, 0)), true, "23:00");
    assert.equal(isScheduleActive(night, at(2026, 11, 17, 3, 0)), true, "03:00 the next morning");
    assert.equal(isScheduleActive(night, at(2026, 11, 17, 5, 59)), true, "05:59");
    assert.equal(isScheduleActive(night, at(2026, 11, 17, 6, 0)), false, "06:00");
    assert.equal(isScheduleActive(night, at(2026, 11, 16, 12, 0)), false, "noon");
  });

  it("a short span is active until its end instant", () => {
    const end = at(2026, 11, 14, 16, 33, 30);
    const span: Schedule = { untilAt: end.toISOString() };
    assert.equal(isScheduleActive(span, new Date(end.getTime() - 1000)), true);
    assert.equal(isScheduleActive(span, end), false);
  });

  it("overnight ranges respect days by their start day", () => {
    const fridayNight: Schedule = { days: ["fri"], start: "22:00", end: "06:00" };
    assert.equal(isScheduleActive(fridayNight, at(2026, 11, 21, 3, 0)), true, "Saturday 03:00 is Friday night");
    assert.equal(isScheduleActive(fridayNight, at(2026, 11, 22, 3, 0)), false, "Sunday 03:00 is Saturday night");
    assert.equal(isScheduleActive(fridayNight, at(2026, 11, 19, 23, 0)), false, "Thursday 23:00");
  });

  it("keeps Saturday night across the US daylight-saving transitions", () => {
    const sat: Schedule = { days: ["sat"], start: "22:00", end: "06:00" };
    const instants = [
      new Date("2026-10-31T22:30:00-04:00"),
      new Date("2026-11-01T01:30:00-04:00"),
      new Date("2026-11-01T01:30:00-05:00"),
      new Date("2026-11-01T03:30:00-05:00"),
      new Date("2026-03-07T22:30:00-05:00"),
      new Date("2026-03-08T01:30:00-05:00"),
      new Date("2026-03-08T03:30:00-04:00"),
    ];
    // Wall-clock checks only mean this in a US Eastern process. UTC CI skips them.
    if (instants.some((date) => date.getHours() !== 1 && date.getHours() !== 3 && date.getHours() !== 22)) return;
    for (const date of instants) assert.equal(isScheduleActive(sat, date), true, date.toISOString());
    assert.equal(isScheduleActive(sat, new Date("2026-11-01T06:00:00-05:00")), false);
    assert.equal(isScheduleActive(sat, new Date("2026-03-08T06:00:00-04:00")), false);
  });
});

describe("describeSchedule", () => {
  it("names common day sets and keeps times readable", () => {
    assert.equal(describeSchedule({ days: ["fri", "mon", "tue", "wed", "thu"], start: "09:00", end: "17:00" }), "Weekdays 9:00 to 17:00");
    assert.equal(describeSchedule({ days: ["sat", "sun"], start: null, end: null }), "Weekends");
    assert.equal(describeSchedule({ start: "22:00", end: "06:00" }), "Daily 22:00 to 6:00");
    assert.equal(describeSchedule({ days: ["wed", "mon"], start: "18:30", end: "20:00" }), "Mon, Wed 18:30 to 20:00");
  });

  it("adds date ranges and returns null when there is no schedule", () => {
    assert.equal(describeSchedule({ start: "09:00", end: "17:00", until: "2026-12-15" }), "Daily 9:00 to 17:00, until Dec 15");
    assert.equal(describeSchedule({ until: "2026-12-15" }), "Until Dec 15");
    assert.equal(describeSchedule({ from: "2026-11-20", until: "2026-12-01" }), "Nov 20 to Dec 1");
    assert.equal(describeSchedule(null), null);
    const end = at(2026, 11, 14, 16, 33, 30);
    assert.equal(describeSchedule({ untilAt: end.toISOString() }), "Until 16:33:30");
  });
});

describe("parseSpokenSchedule", () => {
  const now = at(2026, 11, 14, 16, 33, 0);

  it("turns a next-seconds phrase into an end instant", () => {
    const schedule = parseSpokenSchedule("for the next 30 seconds, don't show videos", now);
    assert.equal(schedule?.untilAt, addSeconds(now, 30).toISOString());
    assert.equal(schedule?.start, null);
    assert.equal(schedule?.days, null);
  });

  it("keeps weekends as Saturday and Sunday", () => {
    assert.deepEqual(parseSpokenSchedule("ignore podcasts on weekends", now), { days: ["sat", "sun"], start: null, end: null });
  });

  it("treats this weekend spoken on Saturday as that Saturday and Sunday", () => {
    const schedule = parseSpokenSchedule("ignore podcasts this weekend", now);
    assert.deepEqual(visibleSchedule(schedule), {
      days: null,
      start: null,
      end: null,
      from: "2026-11-14",
      until: "2026-11-15",
      untilAt: null,
    });
    assert.equal(isScheduleActive(schedule, at(2026, 11, 14, 16, 33)), true, "Saturday afternoon");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 15, 12, 0)), true, "Sunday");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 16, 16, 33)), false, "Monday after");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 21, 16, 33)), false, "the Saturday after");
  });

  it("treats this weekend spoken on Wednesday as the upcoming Saturday and Sunday", () => {
    const schedule = parseSpokenSchedule("ignore podcasts this weekend", at(2026, 11, 11, 16, 33, 0));
    assert.deepEqual(visibleSchedule(schedule), {
      days: null,
      start: null,
      end: null,
      from: "2026-11-14",
      until: "2026-11-15",
      untilAt: null,
    });
    assert.equal(isScheduleActive(schedule, at(2026, 11, 11, 16, 33)), false, "Wednesday");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 13, 16, 33)), false, "Friday");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 14, 16, 33)), true, "Saturday afternoon");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 16, 16, 33)), false, "Monday after");
    assert.equal(isScheduleActive(schedule, at(2026, 11, 21, 16, 33)), false, "the Saturday after");
  });

  it("keeps on weekends repeating with no dates on Saturday and Wednesday", () => {
    const spoken = [
      ["Saturday", now],
      ["Wednesday", at(2026, 11, 11, 16, 33, 0)],
    ] as const;
    for (const [day, spokenAt] of spoken) {
      const schedule = parseSpokenSchedule("ignore podcasts on weekends", spokenAt);
      assert.deepEqual(schedule, { days: ["sat", "sun"], start: null, end: null }, day);
      assert.equal(isScheduleActive(schedule, at(2026, 11, 14, 16, 33)), true, `${day} Saturday afternoon`);
      assert.equal(isScheduleActive(schedule, at(2026, 11, 16, 16, 33)), false, `${day} Monday after`);
      assert.equal(isScheduleActive(schedule, at(2026, 11, 21, 16, 33)), true, `${day} the Saturday after`);
    }
  });

  it("keeps only the length when a clock window is in the same sentence", () => {
    const end = addHours(now, 2);
    const schedule = parseSpokenSchedule("for the next 2 hours between 09:00 and 17:00, don't show videos", now);
    assert.equal(schedule?.untilAt, end.toISOString());
    assert.equal(schedule?.start ?? null, null);
    assert.equal(schedule?.end ?? null, null);
    assert.equal(schedule?.days ?? null, null);
    assert.equal(schedule?.from ?? null, null);
    assert.equal(schedule?.until ?? null, null);
    assert.equal(isScheduleActive(schedule, at(2026, 11, 14, 17, 30)), true, "17:30, after 17:00 and before the length ends");
    assert.equal(isScheduleActive(schedule, new Date(end.getTime() - 1000)), true, "one second before the end");
    assert.equal(isScheduleActive(schedule, end), false, "the end instant");
  });

  it("reads spans written in words, so they still end", () => {
    const end = (message: string) => parseSpokenSchedule(message, now)?.untilAt ?? null;
    assert.equal(end("don't show videos for a minute"), addSeconds(now, 60).toISOString());
    assert.equal(end("hide videos for an hour"), addHours(now, 1).toISOString());
    assert.equal(end("hide videos for the next hour"), addHours(now, 1).toISOString());
    assert.equal(end("dim the page for half an hour"), addSeconds(now, 1800).toISOString());
    assert.equal(end("hide videos for an hour and a half"), addSeconds(now, 5400).toISOString());
    assert.equal(end("hide 5 minute videos"), null);
  });

  it("turns until a clock time into the next time that clock comes round", () => {
    assert.equal(parseSpokenSchedule("hide videos until 5pm", now)?.untilAt, at(2026, 11, 14, 17).toISOString());
    assert.equal(parseSpokenSchedule("hide videos until noon", now)?.untilAt, at(2026, 11, 15, 12).toISOString());
    assert.equal(parseSpokenSchedule("hide videos until December 15", now), null);
  });

  it("reads 9 to 5 as a working day, not 9 to 5 in the morning", () => {
    const window = (message: string) => {
      const schedule = parseSpokenSchedule(message, now);
      return [schedule?.start ?? null, schedule?.end ?? null];
    };
    assert.deepEqual(window("hide shorts on weekdays from 9 to 5"), ["09:00", "17:00"]);
    assert.deepEqual(window("hide shorts on weekdays 9 to 5"), ["09:00", "17:00"]);
    assert.deepEqual(window("hide shorts weekdays 9-5"), ["09:00", "17:00"]);
    assert.deepEqual(window("hide shorts from 1 to 3"), ["13:00", "15:00"]);
    assert.deepEqual(window("dark mode from 9pm to 6"), ["21:00", "06:00"]);
    assert.deepEqual(window("dark mode from 8pm to 6am"), ["20:00", "06:00"]);
    assert.deepEqual(window("hide twitter 9am-5pm"), ["09:00", "17:00"]);
    assert.deepEqual(window("hide twitter from 09:00 to 17:00"), ["09:00", "17:00"]);
    assert.equal(parseSpokenSchedule("make it 2-3 px bigger", now), null);
    assert.equal(parseSpokenSchedule("make text 2 to 3 times bigger", now), null);
  });
});

describe("withSpokenSchedule", () => {
  const now = at(2026, 11, 14, 16, 33, 0);
  const base: Change = { id: "dark", summary: "Dark mode", reason: "asked", css: "", dom: [], block: null, scope: "site" };

  it("keeps the model's overnight reading when the user gave no am or pm", () => {
    const change = withSpokenSchedule({ ...base, schedule: { start: "20:00", end: "06:00" } }, "dark mode from 8 to 6", now);
    assert.deepEqual([change.schedule?.start, change.schedule?.end], ["20:00", "06:00"]);
  });

  it("fixes a model clock that disagrees with the user's hours", () => {
    const change = withSpokenSchedule({ ...base, schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "05:00" } }, "hide shorts weekdays 9 to 5pm", now);
    assert.deepEqual([change.schedule?.start, change.schedule?.end], ["09:00", "17:00"]);
  });
});

describe("lastingRequest", () => {
  it("drops a counted span and keeps the request", () => {
    assert.equal(lastingRequest("hide podcasts for 30 seconds"), "hide podcasts");
    assert.equal(lastingRequest("don't show videos for the next 30 seconds"), "don't show videos");
    assert.equal(lastingRequest("for the next 30 seconds, don't show videos"), "don't show videos");
    assert.equal(lastingRequest("for the next 2 hours between 09:00 and 17:00, don't show videos"), "don't show videos");
  });

  it("leaves repeating rules unchanged", () => {
    assert.equal(lastingRequest("ignore podcasts on weekends"), null);
    assert.equal(lastingRequest("hide shorts between 17:00 and 19:00"), null);
    assert.equal(lastingRequest("for a minute"), null);
  });

  it("treats only an untilAt span as one time", () => {
    assert.equal(isOneShot({ untilAt: "2026-11-14T21:33:30.000Z" }), true);
    assert.equal(isOneShot({ days: ["sat", "sun"], untilAt: "2026-11-14T21:33:30.000Z" }), false);
    assert.equal(isOneShot({ days: ["sat", "sun"] }), false);
    assert.equal(isOneShot(null), false);
  });
});
