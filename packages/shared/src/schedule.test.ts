import { expect, test } from "bun:test";
import { Schedule, describeSchedule, isScheduleActive } from "./schedule";

const at = (iso: string) => new Date(iso);
const workHours = Schedule.parse({ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" });

test("weekdays 9 to 5", () => {
  expect(isScheduleActive(workHours, at("2026-11-16T08:59:00"))).toBe(false);
  expect(isScheduleActive(workHours, at("2026-11-16T09:00:00"))).toBe(true);
  expect(isScheduleActive(workHours, at("2026-11-16T16:59:00"))).toBe(true);
  expect(isScheduleActive(workHours, at("2026-11-16T17:00:00"))).toBe(false);
  expect(isScheduleActive(workHours, at("2026-11-14T12:00:00"))).toBe(false);
  expect(describeSchedule(workHours)).toBe("Weekdays, 09:00–17:00");
});

test("date ranges are inclusive", () => {
  const finals = Schedule.parse({ from: "2026-11-20", until: "2026-12-05" });
  expect(isScheduleActive(finals, at("2026-11-19T23:59:00"))).toBe(false);
  expect(isScheduleActive(finals, at("2026-11-20T00:00:00"))).toBe(true);
  expect(isScheduleActive(finals, at("2026-12-05T23:59:00"))).toBe(true);
  expect(isScheduleActive(finals, at("2026-12-06T00:00:00"))).toBe(false);
  expect(describeSchedule(Schedule.parse({ until: "2026-12-15" }))).toBe("until 2026-12-15");
});

test("overnight ranges belong to the day they start", () => {
  const nights = Schedule.parse({ days: ["fri"], start: "22:00", end: "06:00" });
  expect(isScheduleActive(nights, at("2026-11-20T23:00:00"))).toBe(true);
  expect(isScheduleActive(nights, at("2026-11-21T05:00:00"))).toBe(true);
  expect(isScheduleActive(nights, at("2026-11-21T07:00:00"))).toBe(false);
  expect(isScheduleActive(nights, at("2026-11-21T23:00:00"))).toBe(false);
});

test("invalid schedules are rejected", () => {
  expect(Schedule.safeParse({}).success).toBe(false);
  expect(Schedule.safeParse({ start: "09:00" }).success).toBe(false);
  expect(Schedule.safeParse({ start: "9:00", end: "17:00" }).success).toBe(false);
  expect(Schedule.safeParse({ from: "2026-12-05", until: "2026-11-20" }).success).toBe(false);
});
