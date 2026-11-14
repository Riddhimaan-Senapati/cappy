# Handoff: time-based rules and schedule status

Superseded by `docs/handoffs/next.md` at `5207ee7`. This file describes the branch before spoken time spans, ghost suggestions, and the event-log toggle.

Branch `feat/schedule-status`, PR #7 against `main`. Rebased on `main` at `5c8187f`. Not merged yet.

## What already existed on main

Time-based rules work without this PR. Any `Change` can carry a `schedule` (`shared/adaptation.ts`):

```ts
schedule: { days?: ("mon" | ... | "sun")[] | null; start?: "HH:MM" | null; end?: "HH:MM" | null; from?: "YYYY-MM-DD" | null; until?: "YYYY-MM-DD" | null } | null
```

- `isScheduleActive(schedule, now)` in `shared/validate.ts` decides whether a change is on. Windows may cross midnight (22:00 to 06:00 counts as the day it started on). Dates are inclusive.
- The content engine (`extension/src/content/engine.ts`) keeps scheduled changes registered with `live: null` while they are off. It re-checks every 30 s and on `visibilitychange`, and switches them on or off with a view transition.
- `apply_change` returns `waitingForSchedule: true` for a change saved outside its window. The prompt tells the model this is correct, not a failure.
- The system prompt tells the model to set `schedule` only when the user limits the time ("weekdays 9 to 5", "after 10pm", "until December 15").
- Combined with `contentFilter`, this covers Evolve's example: "on YouTube, hide Shorts and gaming videos between 9 AM and 5 PM".

## What this PR adds

Before this PR, users had no way to see a schedule. A rule like "hide Shorts 9 to 5" gave no sign of when it applied, or why nothing was hidden at 6 pm.

- `describeSchedule(schedule)` in `shared/validate.ts` turns a schedule into plain words: "Weekdays 9:00 to 17:00", "Weekends", "Mon, Wed 18:30 to 20:00", "Daily 22:00 to 6:00, until Dec 15". It returns null for no schedule.
- `scheduleStatus(schedule, now?)` appends " · on now" or " · off right now".
- `AppliedSummary.schedule` (`extension/src/messages.ts`) carries the status from the service worker to the UI (`summaries()` in `extension/src/background/agent.ts`).
- The status is shown in three places:
  - bar result cards, in place of the reason (`renderCard` in `extension/src/overlay/spotlight.ts`);
  - change history rows, in place of "5m ago" (`renderHistory`);
  - Settings → On this page, under the change (`extension/src/ui/settings.ts`).
- The stub provider reads "between 9am and 5pm", "from 14:00 to 15:00", "on weekdays" and "on weekends" into a schedule (`stubSchedule` in `server/agent/providers/stub.ts`).

## Tests

- `tests/schedule.test.ts`: covers `describeSchedule` for day sets, overnight windows and date ranges.
- `tests/stub-provider.test.ts`: covers `stubSchedule` and checks that the schedule reaches the filter change.
- `scripts/e2e/schedule.ts` runs on `/demo/youtube.html`:
  - "hide podcasts between (now − 1h) and (now + 1h)" hides the `[data-podcast]` items.
  - "hide shorts between (now + 2h) and (now + 3h)" leaves `[data-shorts]` visible and saves the change with its schedule.
  - Change history shows "on now" and "off right now".
  - The windows are computed from the current clock, so the test passes at any time of day.

Run `bun run typecheck`, `bun run test`, `bun run e2e`. The e2e suite needs port 8787 free on IPv4 and IPv6, and the harness refuses to start otherwise. The last full run was 121 unit tests and 11 of 11 e2e scenarios passing.

## Gotchas

- A filter whose keywords match no single item group is saved with scope `everywhere` in `globalChanges`, not under the site in `siteChanges`. Check both when you look for a saved rule.
- The status text is computed when it is rendered. Change history and Settings update when they re-render. A result card keeps the status it had when the run finished.
- Times use the browser's local clock and time zone (`clientTime` is sent with each run, so the model can turn "until Friday" into a date).
- The time keeps its hour without a leading zero ("6:00"), and there are no en dashes ("to" separates the two times).

## Open items

1. **No list of all rules.** Status only shows for changes on the current page. A "Rules" view in Settings, listing every scheduled change across sites from `siteChanges` and `globalChanges`, would let users review and remove them in one place.
2. **No next switch time.** "off right now" could say when the rule turns on next ("on at 9:00"). That needs a small `nextScheduleChange(schedule, now)` helper next to `isScheduleActive`.
3. **No way to edit a schedule.** Users can only undo a rule and ask again. The cheapest fix is an inline edit of days and times on the Settings row, which saves through `recordApplied`.
4. **Remembered schedules.** "No podcasts on weekdays 9-5" saved as a memory line is re-implemented by the page-load run on each new site. The run applies it with the right `schedule` field, but nothing checks that the model kept the schedule. A unit test on the prompt, or a stub e2e, would catch regressions.
5. **The side panel does not show status.** It only lists steps. Add `schedule` to its done-event rendering if the side panel is used for demos.
