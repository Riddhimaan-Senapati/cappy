import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isScheduleActive } from "../shared/validate.ts";
import type { Change } from "../shared/adaptation.ts";

type Schedule = NonNullable<Change["schedule"]>;
const at = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo - 1, d, h, m);

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

  it("overnight ranges respect days by their start day", () => {
    const fridayNight: Schedule = { days: ["fri"], start: "22:00", end: "06:00" };
    assert.equal(isScheduleActive(fridayNight, at(2026, 11, 21, 3, 0)), true, "Saturday 03:00 is Friday night");
    assert.equal(isScheduleActive(fridayNight, at(2026, 11, 22, 3, 0)), false, "Sunday 03:00 is Saturday night");
    assert.equal(isScheduleActive(fridayNight, at(2026, 11, 19, 23, 0)), false, "Thursday 23:00");
  });
});
