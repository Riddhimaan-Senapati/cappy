# CLAUDE.md

Engineering guide for this repo. The product brief is `PROJECT.md`, which is shared outside the repo; "Status against the brief" below tracks it.

## What it is

A Chrome extension (MV3) with an AI agent that adapts the page you are on to your needs (colorblindness, light sensitivity, text size, focus, motor limits). You open a Spotlight-style bar, say what you need, and the agent changes the live page, verifies it, and lets you undo. It can also act on page load from your saved profile.

Scope: the agent changes how pages look, read and respond. It never clicks, types, fills forms or navigates for the user; that is left to computer-use agents such as Sentient's.

## Architecture

```
Chrome extension                                        Local Node server (holds keys)
  content script  bar UI, floating button, toasts,          agent loop per provider
                  reads page, applies and undoes   <--WS-->  tools: read_page, inspect, apply_change,
                  changes, re-applies on new DOM               revert_change, screenshot, remember,
                                                               list_items, find_site_features,
                                                               use_site_control, load_skill,
                                                               save_site_skill, escalate
  service worker  owns the WebSocket, runs tool              safety: CSS scan, op allowlist,
                  calls against the tab, request queue,       prompt-injection check
                  voice (offscreen) and read-aloud
  camera page     MediaPipe hand and face tracking        routing: fast / pro tier
  offscreen doc   microphone, speech recognition,            usage: token counts per run
                  pause detection, cloud audio
  popup           settings, including LLM usage
  side panel      debug chat, tool log, page inspector
  chrome.storage  profile, pending memory, site skills, request sessions,
                  saved changes, saved commands, activity counts, settings
```

- The server is required for new requests: it keeps API keys and credentials out of the extension and runs the provider SDKs. Saved changes, undo and settings work without it.
- One run = one tool-use loop. The page outline is sent with the request, so the model can act on its first turn.
- A request sent while a tab is busy is queued in the service worker. The queue drains in order only after a successful reply. Send now (Ctrl/Cmd+Enter) cancels the running request instead (the server aborts the model call); Stop cancels it and keeps the queue and any applied changes.
- Point and speak: with the bar closed, the dictation shortcut listens without covering the page. The element under the camera air pointer (deliberate) or the mouse (only when the request says "this", "that", "here") becomes the request's target, so "make this red" changes that element (`extension/src/voice/point.ts`). With camera control, pinch-and-hold selects and starts listening.
- Voice ends after about 1.2 s of silence (a ring drains on the mic and the Listening pill; speaking again cancels it), when the user says "done" or "send it", at 15 s, or when a pinch hold is released. Loudness is measured in the offscreen document against an adaptive noise floor and the user's own speaking level, with automatic gain off (`extension/src/voice/endpoint.ts`). For OpenAI and Gemini voice, "done" is spotted live only by Chrome's on-device recognizer.
- Friction suggestions: content-script sensors (`extension/src/content/sensors.ts`) and zoom events log zoom, pinch-zoom, rage clicks and near-miss clicks as counts in 5-minute buckets for 6 hours plus all-time totals (`extension/src/friction-log.ts`). Two events on a page within 2 minutes (5-minute cooldown) trigger one `suggest` call with those counts and the feedback log; the reply is ghost text with a dismiss button above the floating button, and the bar's top item. Accept, dismiss and an undo within 30 s are recorded as feedback for later suggestions. A dismissal is remembered, so the same suggestion stays hidden and that site will not suggest again for 5 minutes. For a demo, open Settings, then Memory, then Activity, then Clear. That forgets the dismissal and resets the wait. Zoom in twice within 2 minutes and the ghost text comes back.
- Vague requests, or a rejection without a stated alternative, get `offer_options`: 2 to 4 choices that run as follow-ups in the same session and can be edited first.
- Camera control (main's gestures): air pointer, pinch click, pinch-and-hold to select a target element, dwell click, hand and head scrolling, swipe back and forward, thumbs-down to cancel. The mouse picker and the right-click "Adapt this" menu select targets too; a targeted request changes only that element.
- LLM usage and the page inspector: providers report token counts per run, shown in Settings (popup and bar); the side panel can list what the extension changed on the current page. Settings has Track events, on by default, which keeps the inspector's event log (the latest 100). Turning it off stops recording and clears that log. It does not affect friction counts or suggestions.
- Reopening a saved request continues its session: follow-ups carry up to four earlier successful prompt-and-reply pairs from it.
- Saved changes replay on page load with no model call. Repeating the same request on a site is served from storage; Shift+Enter asks the model again.
- DOM ops and text scaling re-apply to content added later (a MutationObserver in `extension/src/content/engine.ts`). CSS keeps applying on its own.
- The overlay lives in a closed shadow root rendered in the top layer (`popover`), so page-wide filters and site modals do not affect it.

## The change format (the core contract)

Defined in [shared/adaptation.ts](shared/adaptation.ts), validated in [shared/validate.ts](shared/validate.ts) on the server and again in the content script.

```ts
Change = { id, summary, reason, css, dom, block, scope: "site" | "everywhere", schedule }
```

The model decides how to implement a need, in this order of preference:
1. `css` it writes itself (invert, dim, spacing, fonts, hiding, focus rings, target size).
2. `dom` ops for what CSS cannot do: `addLabel`, `setAttribute` (allowlisted attributes), `removeAttribute`, `pauseMedia`, `reorder`.
3. `block`, pre-written code we own: `colorblind`, `textScale`, `stopMotion`, `darkMode`, `contentFilter`, `formFixer`.

Before any of these, the agent looks for the site's own controls (`find_site_features`, `use_site_control`) for display and content settings.

To add a capability: schema in `shared/adaptation.ts`, allowlist in `shared/validate.ts`, implementation in `extension/src/content/engine.ts` or `blocks.ts`, one line in the system prompt in `server/agent/prompt.ts`.

## Security rules (non-negotiable)

- The model never writes JavaScript. No `eval`, no `innerHTML` with model or page text, no model-chosen attributes outside the allowlist. Text goes in with `textContent`.
- CSS is rejected if it has `url()`, `@import`, `@font-face`, `image-set()`, `expression()`, `javascript:`, backslash escapes, markup, or any `content:` value other than none/normal/"".
- Page content is untrusted and wrapped in `<untrusted_page_data>`. The injection check runs before any model call and on every re-read; a hit blocks all changes. Test page: `/demo/trap.html`.
- API keys and the ChatGPT credentials file live only on the server and are gitignored. Only short profile lines go to the model.
- The WebSocket accepts only `chrome-extension://` origins.

## Providers and models

Nothing is required in `.env`. The server starts with no provider; the settings view (popup or `/settings` in the bar) lists ChatGPT, Claude, OpenAI API and Gemini, with Sign in or Add key for each, and lets you switch between the ready ones.

- Keys added from settings are saved by the server to `.agent-keys.json` (gitignored, 0600). Keys in `.env` also count. The extension never stores keys.
- `chatgpt-signin` uses OpenAI's documented sign-in for local open-source apps; the Sign in button runs the same flow as `bun run chatgpt:login`. Claude subscription logins are not allowed in third-party tools, so Claude means an API key.
- With no provider picked, the first ready one wins (ChatGPT, Claude, OpenAI, Gemini), or `LLM_PROVIDER` if set and ready.
- Each provider has a Fast and a Pro model; picks are stored per provider. Routing defaults to Auto; Tab in the bar cycles Auto, Fast and Pro. In `auto`, keywords give a first guess, and the fast model can call `escalate` when a request is beyond it; the server then undoes its changes and reruns on Pro (it also does this when Fast's changes fail). Model lists are fetched only for the selected provider, since listing costs an API call.
- Adding a provider: implement `AgentProvider` in `server/agent/providers/` over the shared `tools` list, honour `session.signal` for cancellation, register it in `providers/index.ts`.

## Memory (integration point)

Long-term memory (learned preferences, friction signals, Sentient notes) plugs in through `server/agent/memory.ts`:

- `recallForRun(request)` returns the lines the agent sees as `<profile>` for this run. Today it returns the profile lines the extension sends.
- `rememberFacts(request, lines)` receives durable facts the agent learns through its `remember` tool. Today the extension stores them in its profile and this is a no-op.

Keep what reaches the model short (a few lines), never raw notes or messages. Profile editing in settings keeps working either way.

Nothing is saved to memory without the user. Every `remember` line is proposed with the agent's suggested scope and the user picks **Only on <host>**, **All sites** or **Don't save** (bar, toast, side panel or settings). Site-only lines are stored as `On <host>: <line>` and `profileFor` in `extension/src/memory.ts` sends them only on that host. A suggestion accepted from the ghost text offers its memory line the same way, together with Undo.

Runs also carry `<recent_activity>`: one line of friction counts per kind (10 minutes, 1 hour, 6 hours, all time). It never includes page text or other sites' names.

## Skills

Site skills are different: facts about how one website is built (stable card selectors, where its controls live, quirks), saved by the agent with `save_site_skill` and stored per host in `chrome.storage` (`siteSkills`), never on the server. Later runs on that host get them as `<site_skill>` wrapped as untrusted data. Notes come from page content, so the tool refuses them on blocked pages or when they read like instructions, and caps their length and count. They never hold anything about the user; settings lists them with Forget.

Playbooks for kinds of requests live in `server/skills/*.md` (front matter: `name`, `description`). The prompt lists names and descriptions; the model loads one with `load_skill` when a request matches, by meaning rather than keywords. Edit or add a file to change behavior; no restart needed.

## Time-based rules

Any change can carry a `schedule` (days, a daily window that may cross midnight, from/until dates, or an absolute `untilAt` instant) in `shared/adaptation.ts`. `isScheduleActive` in `shared/validate.ts` decides whether it is on; the engine keeps scheduled changes registered and switches them every 30 s, on tab focus, and at a short span's end. The server reads the user's words with chrono-node and date-fns (`server/agent/schedule.ts`) and writes that schedule onto `apply_change`, so "for the next 30 seconds, don't show videos" ends at that instant and "ignore podcasts on weekends" is Saturday and Sunday. Combined with `contentFilter` this also covers rules like "hide Shorts on weekdays 9 to 5". Showing the schedule and "on now / off right now" in the UI is PR #7 (`feat/schedule-status`).

## Repo layout

```
shared/        change schema, validator, WebSocket protocol
server/        Express + WebSocket entry, agent session, tools, prompt, router, providers, ChatGPT sign-in
extension/src/
  background/  WebSocket client, run orchestration and queue, voice relay, TTS
  content/     page reading, change engine, blocks, sensors, site controls, gestures, picker
  overlay/     Spotlight bar, floating button, toast, suggestion
  voice/       voice controller, pause detection, point-and-speak target choice
  camera/      MediaPipe tracking page
  offscreen/   microphone and speech
  ui/          shared settings view, memory, usage, inspector, theme, DOM helpers
  popup.ts, sidepanel.ts
demo-sites/    campus, trap, YouTube, X, Instagram, form and dark-mode test pages
scripts/e2e/   Playwright scenarios against the stub provider (one per file)
tests/         unit tests (node:test via tsx)
```

## Running

```bash
bun install
bun run dev               # server on :8787 + extension build in watch mode
```

Load `extension/` unpacked at `chrome://extensions`, then set up a provider from the extension settings. Shortcuts: Ctrl+Shift+Space (bar), Alt+Shift+M (dictation), Ctrl+Shift+Y (debug panel); rebind at `chrome://extensions/shortcuts`. `bun run typecheck`, `bun run test` and `bun run e2e` before pushing (e2e needs port 8787 free).

## Conventions

- TypeScript strict, ESM. Keep `extension/src/content/` free of zod and server code; it is bundled into every page.
- No comments unless they explain a non-obvious why, one short line. No em dashes in code or strings.
- Use SDK types and helpers; do not hand-roll API shapes.
- Never commit `.env`, `.agent-keys.json` or `.chatgpt-credentials.json`; check `git diff --cached --stat` before committing.
- Commit messages: one line, `type: short description`.

## Status against the brief

Done:
- Plain-language requests install live, with a reason on every change, one Undo for the whole run, pre-blur on page load, and a proactive page-load run from the saved profile.
- Building blocks: form fixer (axe-checked), colorblind color fix, text scaling and focus (CSS, content filter, stop motion), and hand-gesture scrolling through camera control. Read-aloud is done as well.
- Verification: matched counts and before/after accessibility stats on every change, with fix-or-revert. Change history toggles each change on and off.
- Learning from friction (zoom, misclicks), with consent: every memory asks for a scope, the profile is editable in settings, and the injection trap page is blocked.
- Safety layer: no model-written code, CSS scan, op allowlist, untrusted page fencing, injection check, global kill switch, keys only on the server.

Partly done:
- Before/after verification is shown as stat deltas, not as screenshots judged by a model or a before/after toggle in the side panel.
- Color fix covers images, video and pages with a color matrix; recoloring chart CSS is not specific.
- First change in about 1.5 s is not measured. Repeat requests and saved changes skip the model.

Not started:
- One-minute onboarding chat that builds the first profile.
- Approval before an "everywhere" change runs on a site for the first time (the brief asks for one click per new site).
- Stretch blocks: Sentient OS connector (`server/agent/memory.ts` is the integration point), MongoDB adaptation library, Tiger Data friction dashboard, audio balance, flash calming, alt-text writer, Grok Bot QA.
- Rehearsal on the brief's demo sites (W3C survey and tickets, Mars Commuter, GOV.UK forms, Silktide, Our World in Data), backup video, domain and Devpost write-up.

Changed from the brief on purpose:
- Feed ranking and hiding content by taste are built (`reorder`, `contentFilter`, time-based rules), although the brief listed them as out of scope.
- Any of ChatGPT, Claude, OpenAI or Gemini can run the agent, not only Gemini, and state lives in `chrome.storage` instead of MongoDB.
- Friction is kept as local counts, not a Tiger Data time series.
