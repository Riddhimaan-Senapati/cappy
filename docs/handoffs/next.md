# Handoff: spoken schedules, ghost suggestions, event log

Follow this file. `docs/handoffs/schedule-status.md` is the handoff from before `5207ee7` and is out of date on short spans, the suggestion UI, and the inspector log.

Branch `feat/schedule-status`, PR #7 against `main`. Spoken spans landed in `5207ee7`. Not merged. `CLAUDE.md` matches that commit.

## Spoken time spans

Any `Change` can carry a `schedule`. Besides days, an HH:MM window, and from/until dates, it now has `untilAt`: an ISO datetime when a short span ends (`shared/adaptation.ts`).

`server/agent/schedule.ts` reads the user's words and `apply_change` (`server/agent/tools.ts`) writes the result onto the change, using `clientTime` when the request has one:

- "for the next 30 seconds", "in 30 seconds", and the same shapes for minutes and hours. chrono-node finds the phrase (`chrono.parse` with `forwardDate: true`). date-fns `addSeconds` turns the count into the end instant. A span like this replaces the whole schedule, so a clock the model guessed does not also apply.
- "on weekdays" and "on weekends" stay day lists (`mon` to `fri`, `sat` and `sun`). Chrono returns nothing for "on weekends". "this weekend" is that one Saturday and Sunday (`from` and `until`, no repeating day list). On a weekday it is the upcoming weekend. On Saturday or Sunday it is the weekend already underway.
- "between 9am and 5pm" and "from 14:00 to 15:00" stay on the regex that was already there. A duration and a clock window in the same sentence keep the duration and drop the window.

`isScheduleActive` is false at and after `untilAt`. `describeSchedule` adds the local time with seconds, hour without a leading zero, for example "Until 16:33:30". The word between two clock times is "to".

The content engine (`extension/src/content/engine.ts`) no longer uses a fixed 30 s interval. `manageScheduleTimer` arms a timeout for the sooner of 30 s and 25 ms after the next `untilAt`. Once that instant has passed, later ticks go back to 30 s. `stopEngine` uses `clearTimeout`.

The prompt tells the model to leave `schedule` null for "for the next 30 seconds", because the server fills `untilAt`. Weekends are still `["sat","sun"]`.

The stub (`server/agent/providers/stub.ts`) matches `hide`, `remove`, `ignore`, and "don't show" (straight or curly apostrophe). It does not call `remember` when the schedule has `untilAt`, so a 30 second hide is not proposed as a lasting preference. A weekend hide is still remembered as `Hide <word>` without the day text.

chrono-node and date-fns stay on the server. The content script bundle is still about 1.2mb and must not import them. `shared/validate.ts` compares timestamps with `Date.parse` and formats the label itself.

## Suggestion, undo, and the event log

These landed in the same commit. Leave them as they are.

- Friction suggestions are ghost text above the floating button, not a card (`nudge` in `extension/src/overlay/ui.ts`). The text is a `button.ghost`; clicking it accepts and runs `spotlight.ask`. The X is `aria-label="Dismiss suggestion"`. The reason is the button's `title`. The line sits at `bottom: 68px` and lifts by the toast height plus 16. It hides after 25 s, and when the bar opens. The same suggestion is still pre-selected at the top of the bar.
- A dismissal is stored in `suggestionFeedback`. The site will not suggest again for 5 minutes (`nudgedAt`), and the suggest prompt tells a real model never to repeat a dismissed suggestion. The stub ignores that feedback and will suggest again after the cooldown plus two zooms within 2 minutes. Settings, then Memory, then Activity, then Clear calls `clearActivity`, which also clears `suggestionFeedback`, the cooldown, and the friction counts. Zoom twice within 2 minutes and the ghost text comes back. That path is the demo reset.
- A finished request shows one gray `button.undo-all` ("Undo" or "Undo all"). The purple per-change `button.link` Undo is gone from the result. Change history still toggles each change. `proposeMemory` passes no undo ids while the bar is open, so the memory toast does not add a second purple Undo. `ask()` does not open the bar, so after a ghost-text accept the bar is often closed and the toast Undo is the one on screen. The verification e2e clicks that toast.
- Settings has Track events, on by default (`trackEvents` in `extension/src/storage.ts`). It gates `recordActivity` in `extension/src/content/inspection.ts` (latest 100). Turning it off clears that in-memory log. It does not affect friction counts or suggestions. On startup, `setEventTracking(state.trackEvents)` runs before the "Restoring saved changes" line. The import-time "content script loaded" line still records while the module default is on, then startup clears the log if tracking is off.

## Tests

- `tests/schedule.test.ts`: `untilAt` on and off, the "Until 16:33:30" label, `parseSpokenSchedule` for 30 seconds and weekends, one weekend for "this weekend", a length that drops a clock window, and no schedule for "for a minute".
- `tests/stub-provider.test.ts`: the old clock windows, plus "don't show videos for the next 30 seconds" (a filter, an `untilAt`, no `remember`) and "ignore podcasts on weekends" (Saturday and Sunday, and a `remember`).
- `scripts/e2e/schedule.ts` on `/demo/youtube.html` still hides podcasts inside a window computed from the clock, leaves shorts visible outside theirs, and checks "on now" / "off right now". It then sends "don't show shorts for the next 8 seconds" and waits until the shorts come back (15 s budget). There is no weekend visibility assertion, because that depends on the weekday. Saturday 14 Nov 2026 would hide them; a Monday run would not.
- `scripts/e2e/verification.ts` waits for a button whose text is "make the text bigger" (`shadowButtonVisible` in `scripts/e2e/lib.ts`). `shadowTextVisible` is the wrong wait: the hidden bar still contains that phrase after the first run.

After `5207ee7`: `bun run test` was 124 passing, and `PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" bun scripts/e2e/schedule.ts` passed. The full `bun run e2e` suite was not re-run. Port 8787 must be free on `127.0.0.1` and `::1`. In the Cursor sandbox, set that Playwright path and run outside the sandbox; the sandbox points Playwright at an empty browser cache. The harness channel is `chromium`.

## Gotchas that are still true

- A filter whose keywords match no item group is saved with scope `everywhere` in `globalChanges`, not under the site in `siteChanges`. Check both.
- Status text is computed at render. History and Settings update when they re-render. A result card keeps the status from when the run finished.
- Times use the browser's local clock. `untilAt` is stored as UTC (`toISOString`) and displayed with `getHours()`.
- The hour has no leading zero ("6:00", "Until 16:33:30"). There are no en dashes.
- Phrases without a number and a unit ("for a minute", "the next half hour") are not parsed. Recurring weekends are the day regex, not chrono, and not the rrule package.

## Still open

These were deferred on purpose. Do not start them unless asked.

1. **Focus list.** Settings has a Focus section. It lists every scheduled change from `siteChanges` and `globalChanges`, with whether it is on, and Remove. These rules are the study and work clutter cuts. The other four items below are still open.
2. **No next switch time.** "off right now" could say when it turns on ("on at 9:00"). That needs a `nextScheduleChange(schedule, now)` next to `isScheduleActive`. `untilAt` already has an absolute end, so this is for repeating windows.
3. **No way to edit a schedule.** Users undo and ask again. An inline edit of days and times on the Settings row, saved through `recordApplied`, is the cheap version. `untilAt` is an instant, so an edit there is a different control.
4. **Remembered schedules.** A memory line such as "Hide podcasts" does not carry the days. Page-load replay of a saved change keeps the `schedule` on that change, because saved changes skip the model. A later page-load run that re-implements the memory line is not checked. A prompt test or a stub page-load case would catch a dropped schedule. The stub's weekend memory line is still `Hide <word>`.
5. **The side panel does not show schedule status.** It lists steps. Add `schedule` to its done-event rendering if the side panel is part of a demo.

Also still unrun: the full e2e suite after `5207ee7`. `verification.ts` changed with the ghost text.
