# Handoff: main after #23, and the open fix PRs

Start here. `next.md` and `schedule-status.md` describe PR #7 before it merged and are kept for history.

Update: #22, #20, #19 and #21 are merged and issues #14 to #18 are closed. The merges also fixed a broken import in `server/agent/classify.ts` and capped the server reconnect to one retry per failure. `fix/time-rules-focus` adds the time parsing fixes and Focus mode. The "Open issues" and "Open PRs" sections below are history.

State as of 15 Nov 2026: `main` is at `6015376` (PR #23 merged). Four fix PRs are open (#19 to #22) and they close all five open issues (#14 to #18). No new feature work is in flight.

## What landed on main since the last handoff

### Time-based rules (PR #7)
- Each scheduled rule shows its schedule in plain words and whether it is on now. You see this on result cards, in change history and in Settings (`describeSchedule` and `scheduleStatus` in `shared/validate.ts`).
- Spoken short spans work: "for the next 30 seconds" sets `schedule.untilAt` (`server/agent/schedule.ts`, chrono-node and date-fns, server only). "this weekend" means one Saturday and Sunday. "on weekends" repeats.
- The engine arms a timer for the next `untilAt` instead of polling every 30 s (`manageScheduleTimer` in `extension/src/content/engine.ts`).
- A short span drops out of history when it ends, and the bar offers the same request again without the time limit.
- Settings → General → Focus rules lists every scheduled change from `siteChanges` and `globalChanges`. Each row shows whether it is on and has a Remove button.

### Named profiles (PR #8, `05ac81a`)
- `/profile` in the bar creates, switches, renames and deletes profiles. The same controls are in Settings.
- Each profile keeps its own memory lines, saved changes, recipes, commands and request history. The active profile's data stays in the normal storage keys, and inactive profiles keep a snapshot in `profiles[id].state` (`extension/src/profiles.ts`, `PROFILE_KEYS` in `extension/src/storage.ts`).
- Switching profiles cancels queued work, removes the old layout from every open tab and restores the new one. You can't delete the last profile.

### Onboarding (PR #23, `d629b94`, `a1c82e5`)
- A new install opens `welcome.html` (`extension/src/welcome.ts`). The steps:
  - Connect an AI.
  - Pick needs: low vision, light, color, reading, focus, motion or motor. Each one writes a memory line.
  - Try the shortcut. The page catches it through `welcomeShortcut`.
  - Allow the microphone, and set voice and camera options.
  - Read tips on what to try.
- It sets `onboarded`. Settings can open it again (`openWelcome`). The e2e harness marks setup done so tests skip it.
- CLAUDE.md still lists onboarding under "Not started". It's done, so that line needs updating.

### Filtering by meaning (`4b469ed`)
- A `contentFilter` can take a plain description ("gaming videos", "clickbait"). Keywords still hide obvious matches right away.
- The fast model judges the remaining items, including ones that load as you scroll (`extension/src/content/content-filter.ts`):
  - Items go in batches of 40, sent after 250 ms.
  - Each verdict is cached per description and item text.
  - The server side is `server/agent/classify.ts`.
- `classify.ts` runs the injection check on the item text first. If it hits, nothing in that batch is hidden, so an injected title only stays unjudged. Item text goes in `<untrusted_page_data>`.

### Settings in the bar (`14b266d`, `f70b88a`)
- The popup is gone. Settings opens inside the bar from the toolbar icon (`chrome.action.onClicked`) or the new gear button.
- Settings has five tabs: General, Memory, AI, Voice, Camera. Track events and export/import are under Memory.
- You can drag the bar by its grip, and it remembers its position.
- `/always <request>` saves a command that runs once on each new site (`commands[].everywhere`, `appliedOrigins`).
- The camera hand pointer can hover and press controls inside the bar (`061fd7c`).

### Providers (`19668d8`)
- SpaceXAI, plus any OpenAI-compatible or Anthropic-compatible host, connects with an API key and a base URL (`server/agent/providers/endpoint.ts` on the AI SDK, and `normalizeBaseURL` in `server/keys.ts`).

### Export and import (`f9e794a`)
- Settings → Memory exports profiles, memory lines, saved changes, commands and request history to JSON, and imports that file on another computer.
- Import replaces the current config. API keys, sign-ins and the server address stay local.
- `extension/src/config.ts` validates the file with zod. Each saved change goes through `validateChange` before it is accepted.

### Safety fix (PR #13, `39645ad`)
- Saved changes and recipe replay used to run straight from storage with no page read. That meant they ran on `trap.html`.
- Now `applyChange` refuses everything when the injection check hits, page-load restore skips saved changes on those pages, and replay reads the page first and stops with the same blocked reply.
- Run status changed too: a delivered reply wins over a later connection error, and a stale socket's close no longer fails the live run.
- `scripts/e2e/replay-trap.ts` covers this.

## Open issues

All five come from one QA retest on `f301810`.

| Issue | Problem | Fixed by |
|---|---|---|
| #14 | Undo leaves the saved recipe, so plain Enter puts the undone change straight back | #21 |
| #15 | Dark mode from one page shows up on other pages of the same origin, including `trap.html` | #21 |
| #16 | The bar offers "Undo make page text larger" on a page where nothing was applied | #21 |
| #17 | Enter sends a highlighted suggestion or an earlier autocomplete match, not what the user typed | #20 |
| #18 | The `profiles` e2e fails: the hide rule is missing after `/profile rename` | #19 |

## Open PRs

All four come from Cursor agents. Each body has its own Chrome steps to check the fix by hand.

### #22: replay stop, socket-bound runs, lean injection reads (mergeable)
A follow-up to the review of #13.
- A replay stopped mid-read or mid-apply used to count as applied, so an `/always` command skipped that origin for good. `tryRecipe` now returns `stopped`.
- Each run is tied to the socket it was sent on, and only that socket's close fails it. A replacement socket clears the old ping interval.
- `applyChange` and restore read a lean surface (title, headings, outline texts and a text sample) for the injection check instead of a full outline.
- The `server/safety.ts` re-export is gone. Import `shared/safety.ts`.

### #20: Enter sends the field (mergeable, fixes #17)
- Enter sends the input unless a row was picked with the arrow keys or clicked.
- Hover is CSS only, so moving the pointer can't change what Enter runs.
- Adds `aria-activedescendant` and option ids.
- Typing an exact command name such as `undo` still sends the text to the model (`EXACT_COMMAND_ON_ENTER = "field"`). This is a product call, still open.
- Adds `scripts/e2e/bar-enter.ts`.

### #19: profile layout across a rename (conflicting, fixes #18)
- The rename never dropped any rules. The cause was timing: a profile switch restored layouts inside a view transition, which landed a frame after the test checked.
- Restores now apply right away, and `restore` lost its animate flag.
- Also adds:
  - a coalescing runner for Settings paints (`extension/src/coalesce.ts`);
  - a status stamp so provider and model changes repaint (`extension/src/status-key.ts`);
  - a 4 s retry when the server probe fails;
  - a rename draft that keeps the name you're typing.
- Its body says it was rebased onto `0129fa1`. The conflict came from #23, which reworked `settings.ts` and `profiles.ts`.

### #21: undo drops the save, one-off changes stay on their page (conflicting, fixes #14, #15, #16)
This is the biggest PR, and it changes the change contract:
- **New scope `page`.** A one-off chat change is stamped with its pathname and replays only on that page.
  - `site` is kept when the user says "this site", the change is scheduled, or it's a content filter with an item selector.
  - `everywhere` is unchanged.
  - This touches `shared/adaptation.ts`, `shared/validate.ts`, `server/agent/tools.ts`, the prompt and the stub.
- Undo removes the change and any recipe on the origin that contains it.
- Dark mode now inverts images a second time, so they keep their real colors (`extension/src/content/dark-mode.ts`).
- It updates CLAUDE.md for the new scope.
- Adds `scripts/e2e/saved-changes.ts`.

### Merge order
Four files are touched by more than one PR:
- `content/index.ts`: #19, #21 and #22.
- `engine.ts`: #21 and #22.
- `tools.ts`: #21 and #22.
- `spotlight.ts`: #20 and #21.

Suggested order:
1. **#22.** It's mergeable and smaller than #21 in the files they share.
2. **#20.** It's mergeable and only shares `spotlight.ts` and `run-all.ts` with #21.
3. **#19.** Rebase it on #23. The work is in `settings.ts`, `profiles.ts` and `content/index.ts`.
4. **#21, last.** Rebase it on the other three. Each of them adds an e2e scenario, so merge the `run-all.ts` lists rather than picking one side.
   - Check that `export`/`import` in `extension/src/config.ts` accepts scope `page`. That zod schema reuses `Change`, so it should pick it up, but an older export with no `page` changes must still import.
   - Check that the Focus rules list and history labels handle `page` ("this page").

After each merge, run `bun run typecheck`, `bun run test` and `bun run e2e`. The PR bodies report 148 to 162 unit tests and 13 or 14 e2e scenarios. After all four, run-all should list 15: the current 13, plus `bar-enter` and `saved-changes`.

## Still not started

- **From the brief:**
  - One-click approval before an every-site change first runs on a new site.
  - A before/after toggle that a screenshot is judged on.
  - The stretch connectors: Sentient, MongoDB, Tiger Data, flash calming, an alt-text writer, audio balance and Grok Bot.
  - Demo rehearsal, a backup video, a domain and the Devpost write-up.
- **Schedules:**
  - A next switch time ("on at 9:00") needs `nextScheduleChange` next to `isScheduleActive`.
  - Schedules can't be edited in place.
  - Nothing checks that a remembered rule keeps its days when the page-load run re-applies it.
  - The side panel shows no schedule status.
- **Docs:**
  - CLAUDE.md's "Status against the brief" predates onboarding, profiles, meaning filters, custom endpoints and settings in the bar.
  - The README doesn't mention profiles, onboarding or `/always`.

## Gotchas

- E2E needs port 8787 free on both `127.0.0.1` and `::1`. The harness refuses to start otherwise, so stop your dev server first.
- Content filters whose keywords match no item group are saved under `globalChanges`, not `siteChanges`. Check both. After #21, also check for scope `page`.
- chrono-node, date-fns and the AI SDK stay on the server. The content script bundle must not import them.
- `classifyItems` uses the fast model on every batch of new items. If a page keeps loading items forever, it keeps making calls. Verdicts are cached, but there is no per-page budget.
- No em dashes or en dashes in code, strings or UI text. Times have no leading zero ("6:00").
