import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addSeconds } from "date-fns";
import { describeSchedule, isScheduleActive } from "../shared/validate.js";
import type { Change } from "../shared/adaptation.js";
import { parseSpokenSchedule } from "../server/agent/schedule.js";

type Schedule = NonNullable<Change["schedule"]>;
const at = (y: number, mo: number, d: number, h: number, m = 0, s = 0) => new Date(y, mo - 1, d, h, m, s);

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
});
