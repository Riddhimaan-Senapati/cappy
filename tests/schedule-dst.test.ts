import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isScheduleActive } from "../shared/validate.js";

const eastern = process.env.TZ === "America/New_York";

describe("US Eastern daylight saving", { skip: eastern ? false : "TZ=America/New_York" }, () => {
  it("keeps Saturday night across the transitions", () => {
    const sat = { days: ["sat" as const], start: "22:00", end: "06:00" };
    const instants = [
      new Date("2026-10-31T22:30:00-04:00"),
      new Date("2026-11-01T01:30:00-04:00"),
      new Date("2026-11-01T01:30:00-05:00"),
      new Date("2026-11-01T03:30:00-05:00"),
      new Date("2026-03-07T22:30:00-05:00"),
      new Date("2026-03-08T01:30:00-05:00"),
      new Date("2026-03-08T03:30:00-04:00"),
    ];
    for (const date of instants) {
      assert.ok(date.getHours() === 1 || date.getHours() === 3 || date.getHours() === 22, date.toISOString());
      assert.equal(isScheduleActive(sat, date), true, date.toISOString());
    }
    assert.equal(isScheduleActive(sat, new Date("2026-11-01T06:00:00-05:00")), false);
    assert.equal(isScheduleActive(sat, new Date("2026-03-08T06:00:00-04:00")), false);
  });
});
