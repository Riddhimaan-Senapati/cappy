# CLAUDE.md

Engineering guide for this repo. Product brief: [PROJECT.md](PROJECT.md).

## What it is

A Chrome extension (MV3) with an AI agent that adapts the page you are on to your needs (colorblindness, light sensitivity, text size, focus, motor limits). You open a Spotlight-style bar, say what you need, and the agent changes the live page, verifies it, and lets you undo. It can also act on page load from your saved profile.

Scope: the agent changes how pages look, read and respond. It never clicks, types, fills forms or navigates for the user; that is left to computer-use agents such as Sentient's.

## Architecture

```
Chrome extension                                        Local Node server (holds keys)
  content script  bar UI, floating button, toasts,          agent loop per provider
                  reads page, applies and undoes   <--WS-->  tools: read_page, inspect, apply_change,
                  changes, re-applies on new DOM               revert_change, screenshot, remember
  service worker  owns the WebSocket, runs tool              safety: CSS scan, op allowlist,
                  calls against the tab, routing              prompt-injection check
  popup           settings                                    routing: fast / pro tier
  side panel      debug chat and tool log
  chrome.storage  profile, history, saved changes, settings
```

- The server is required for new requests: it keeps API keys and credentials out of the extension and runs the provider SDKs. Saved changes, undo and settings work without it.
- One run = one tool-use loop. The page outline is sent with the request, so the model can act on its first turn. A new request on the same tab cancels the running one (server aborts the model call).
- Saved changes replay on page load with no model call. Repeating the same request on a site is served from storage; Shift+Enter asks the model again.
- DOM ops and text scaling re-apply to content added later (a MutationObserver in `extension/src/content/engine.ts`). CSS keeps applying on its own.
- The overlay lives in a closed shadow root rendered in the top layer (`popover`), so page-wide filters and site modals do not affect it.

## The change format (the core contract)

Defined in [shared/adaptation.ts](shared/adaptation.ts), validated in [shared/validate.ts](shared/validate.ts) on the server and again in the content script.

```ts
Change = { id, summary, reason, css, dom, block, scope: "site" | "everywhere" }
```

The model decides how to implement a need, in this order of preference:
1. `css` it writes itself (invert, dim, spacing, fonts, hiding, focus rings, target size).
2. `dom` ops for what CSS cannot do: `addLabel`, `setAttribute` (allowlisted attributes), `removeAttribute`, `pauseMedia`.
3. `block`, pre-written code we own: `colorblind`, `textScale`, `stopMotion`.

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
- `chatgpt-signin` uses OpenAI's documented sign-in for local open-source apps; the Sign in button runs the same flow as `npm run chatgpt:login`. Claude subscription logins are not allowed in third-party tools, so Claude means an API key.
- With no provider picked, the first ready one wins (ChatGPT, Claude, OpenAI, Gemini), or `LLM_PROVIDER` if set and ready.
- Each provider has a Fast and a Pro model; picks are stored per provider. Routing defaults to Fast; Tab in the bar switches to Pro. In `auto`, keywords give a first guess, and the fast model can call `escalate` when a request is beyond it; the server then undoes its changes and reruns on Pro (it also does this when Fast's changes fail). Model lists are fetched only for the selected provider, since listing costs an API call.
- Adding a provider: implement `AgentProvider` in `server/agent/providers/` over the shared `tools` list, honour `session.signal` for cancellation, register it in `providers/index.ts`.

## Memory (integration point)

Long-term memory (learned preferences, friction signals, Sentient notes) plugs in through `server/agent/memory.ts`:

- `recallForRun(request)` returns the lines the agent sees as `<profile>` for this run. Today it returns the profile lines the extension sends.
- `rememberFacts(request, lines)` receives durable facts the agent learns through its `remember` tool. Today the extension stores them in its profile and this is a no-op.

Keep what reaches the model short (a few lines), never raw notes or messages. Profile editing in settings keeps working either way.

## Skills

Playbooks for kinds of requests live in `server/skills/*.md` (front matter: `name`, `description`). The prompt lists names and descriptions; the model loads one with `load_skill` when a request matches, by meaning rather than keywords. Edit or add a file to change behavior; no restart needed.

## Repo layout

```
shared/        change schema, validator, WebSocket protocol
server/        Express + WebSocket entry, agent session, tools, prompt, router, providers, ChatGPT sign-in
extension/src/
  background/  WebSocket client and run orchestration
  content/     page reading, change engine, blocks, content entry
  overlay/     Spotlight bar, floating button, toast
  ui/          shared settings view, theme, DOM helpers
  popup.ts, sidepanel.ts
demo-sites/    campus.html (messy test page), trap.html (injection test)
```

## Running

```bash
npm install
npm run dev               # server on :8787 + extension build in watch mode
```

Load `extension/` unpacked at `chrome://extensions`, then set up a provider from the extension settings. Shortcuts: Ctrl+Shift+Space (bar), Ctrl+Shift+Y (debug panel); rebind at `chrome://extensions/shortcuts`. `npm run typecheck` before pushing.

## Conventions

- TypeScript strict, ESM. Keep `extension/src/content/` free of zod and server code; it is bundled into every page.
- No comments unless they explain a non-obvious why, one short line. No em dashes in code or strings.
- Use SDK types and helpers; do not hand-roll API shapes.
- Never commit `.env`, `.agent-keys.json` or `.chatgpt-credentials.json`; check `git diff --cached --stat` before committing.
- Commit messages: one line, `type: short description`.
