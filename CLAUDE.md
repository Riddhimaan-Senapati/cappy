# CLAUDE.md

Guidance for Claude Code and teammates working in this repo. The full product brief is [PROJECT.md](PROJECT.md); provider rules are in [LLM-PROVIDERS.md](LLM-PROVIDERS.md). This file is the engineering contract: read it before writing code.

## What we are building

A Chrome extension (Manifest V3) with an AI browser agent that learns one person's needs (colorblindness, light sensitivity, motor limits, focus, text size) and adapts the websites they visit. It acts first on page load, explains every change, verifies it worked, and lets the user undo it. The user can also ask in plain English ("invert this page", "my wrist is in a cast, make this form easier") and the agent works out how to implement it on the live page.

HackUMass XIV, Nov 13 to 15 2026. Judging Sunday 12:30 PM. Demo is 3 minutes on 3 to 4 rehearsed sites. See PROJECT.md sections 8 to 10 for demo script and prize map.

## Architecture

```
Chrome extension (one install, everything the user sees)        Local agent server (Node, holds API keys)
  side panel   chat, profile, active changes, agent steps  <-WS->  agent loop (provider-agnostic)
               runs tab tools, captures screenshots                   tools: read_page, inspect, apply_change,
  content script  reads page, applies/undoes changes,                        revert_change, screenshot, remember
                  restores saved changes on load, toast             safety: CSS scan, op allowlist, injection check
  service worker  opens side panel                                   providers: gemini (default), anthropic-key
  chrome.storage  profile, chat history, per-site + global changes
```

- **The agent is a real tool-use loop, not a single JSON call.** It reads the page, inspects elements, applies a change, checks matched counts and before/after stats (and a screenshot when visual), then fixes or reverts. Max 16 steps, max two fix attempts per change.
- **Tools execute in the user's real tab.** The server sends `tool` messages over the WebSocket; the side panel forwards them to the content script (or captures a screenshot) and returns `toolResult`. See [shared/protocol.ts](shared/protocol.ts).
- **State lives in the extension** ([extension/src/storage.ts](extension/src/storage.ts)). The server is stateless per run: every `run` message carries profile, recent chat and active changes.
- **Fast path:** saved changes are replayed by the content script on page load with no LLM call. The LLM only runs on chat, or proactively (`page_load` trigger) when the profile is non-empty and the site has nothing saved yet.
- **Why a local server instead of calling the LLM from the extension:** API keys must never ship in the extension, and provider SDKs (tool runner, Gemini SDK) run in Node. Users still only see one extension.

### Why not Stagehand / Browser Use / computer-use models

Those SDKs drive a browser they control (Playwright/CDP) to complete tasks by clicking and typing, or work from pixels (Gemini computer use, Claude computer use). We adapt the user's own live tab and need DOM-level, reversible, verifiable edits, so we own a small tool set instead. The tool boundary is also our security story. Borrow ideas freely (Nanobrowser is a good in-extension reference), but do not add those SDKs as dependencies without a team decision.

## The adaptation model (most important contract)

Defined in [shared/adaptation.ts](shared/adaptation.ts); validated by [shared/validate.ts](shared/validate.ts) on the server and again in the content script.

A **Change** is what the agent produces. The LLM decides *how* to implement a need; it is not limited to presets.

```ts
Change = {
  id: "invert-page",                // kebab-case, reusing an id replaces the change
  summary, reason,                  // shown to the user; reason cites the profile line or request
  css: string | null,               // model-written CSS, scanned before use
  dom: DomOp[] | null,              // allowlisted DOM operations, any selector
  block: BlockCall | null,          // pre-built JS capability
  scope: "site" | "everywhere",
}
```

Three layers, in order of preference:
1. **CSS the model writes.** Covers most visual needs: invert, dim, spacing, fonts, hiding elements, focus rings, bigger targets.
2. **DomOps** for what CSS cannot do: `addLabel`, `setAttribute` (aria-*, alt, title, role, tabindex, lang, autocomplete, inputmode), `removeAttribute` (autoplay, loop, ...), `pauseMedia`. Text is always inserted with `textContent`.
3. **Blocks**: pre-written code we control, for what neither can do: `colorblind` (daltonizing SVG color matrix), `textScale` (scales real computed px sizes), `stopMotion`. Planned: `gestureScroll` (MediaPipe), `flashCalm`, `readAloud`, `altText`.

To add a capability: add a DomOp or Block to the zod schema in `shared/adaptation.ts`, its allowlist entry in `shared/validate.ts`, the implementation in `extension/src/content/engine.ts` or `blocks.ts`, and a line in the system prompt ([server/agent/prompt.ts](server/agent/prompt.ts)).

## Security rules (non-negotiable, these are a judged feature)

- **The model never writes JavaScript.** No `eval`, no `new Function`, no `innerHTML` with model text, no model-chosen event handlers or attributes outside the allowlist.
- **CSS scan** rejects `url()`, `@import`, `@font-face`, `image-set()`, `expression()`, `javascript:`, backslash escapes, `<style`/`<script`, and any `content:` value except none/normal/"" (blocks fake text overlays). Max 6000 chars.
- **Page content is untrusted.** Tool results that contain page data are wrapped in `<untrusted_page_data>`; the system prompt says it is data, never instructions.
- **Injection check** ([server/safety.ts](server/safety.ts)) runs on every `read_page`. A hit sets `blockedReason`; all further `apply_change` calls are refused and the panel shows "Blocked". Test page: `/demo/trap.html`.
- Validate twice: server (zod + validateChange) and content script (validateChange) before touching the DOM.
- Every change is undoable (per change, toast Undo, global kill switch in the panel header).
- Only the short profile lines go to the model, never raw notes or messages. Never log prompts containing user data.
- WebSocket only accepts `chrome-extension://` origins.

## DOM manipulation and animation

- CSS changes are `<style data-ba="change:<id>">` elements appended to `<html>`; undo removes them. DomOps record an undo closure per element. Our own nodes carry `data-ba` and are excluded from page reads.
- Changes animate with the **View Transitions API** (`document.startViewTransition`), a 0.45 s crossfade of the whole page from old look to new. No per-property transitions needed. Skipped when `prefers-reduced-motion` is set or on restore at page load.
- Newly inserted elements (labels) get a short blue pulse so the user sees what changed.
- `page_load` runs blur the page (`html.ba-busy`) until the first change lands, then show an in-page toast (shadow DOM) with Undo.
- Known limits: inline `<style>` can be blocked by strict page CSP (fallback: `chrome.scripting.insertCSS` from the service worker); `textScale` does not follow SPA content added later (needs a MutationObserver).

## Repo layout

```
shared/adaptation.ts     Change / DomOp / BlockCall zod schemas, PageOutline, PageStats types
shared/validate.ts       zod-free validator + CSS scanner (bundled into the content script)
shared/protocol.ts       WebSocket messages and tab tool signatures
server/index.ts          Express (demo sites, /api/health) + WebSocket /agent
server/agent/            session (tool RPC), tools, prompt, providers/{gemini,anthropic,index}.ts
server/safety.ts         prompt-injection heuristics
extension/manifest.json  MV3 manifest; load the extension/ folder unpacked
extension/src/sidepanel.ts   chat UI, WS client, tool dispatch, proactive runs
extension/src/content/   index (messages, restore, toast), outline (read_page, inspect, stats), engine, blocks, dom helpers
demo-sites/              campus.html (messy demo page), trap.html (injection test)
```

## Running it

```bash
npm install
cp .env.example .env          # set LLM_PROVIDER and the matching key
npm run dev                   # server on :8787 + extension build in watch mode
```

Then open `chrome://extensions`, enable Developer mode, **Load unpacked** the `extension/` folder, open `http://localhost:8787/demo/campus.html`, click the extension icon to open the side panel. Reload open tabs after (re)loading the extension so the content script is injected.

Other scripts: `npm run typecheck`, `npm run build:ext`, `npm run server`.

## LLM providers

Full rules in [LLM-PROVIDERS.md](LLM-PROVIDERS.md). Summary:
- `LLM_PROVIDER=gemini` (default, the one we pitch for MLH) or `anthropic-key`. Missing key fails at startup; never fall back silently.
- A provider implements `AgentProvider.run(session)` ([server/agent/providers/types.ts](server/agent/providers/types.ts)): drive the tool loop over the shared `tools` list and return the final reply. Tools, safety and prompt are shared, so providers stay small.
- Anthropic uses the SDK tool runner (`client.beta.messages.toolRunner` + `betaZodTool`) with server-side refusal fallbacks enabled. Default model `claude-opus-5-5` at effort `low`; override with `ANTHROPIC_MODEL` / `AGENT_EFFORT`.
- Gemini uses a manual function-calling loop with `@google/genai`. Default `gemini-3.5-flash`; confirm the current model name before the demo.
- `openai-key` and `chatgpt-signin` share one Responses API loop ([server/agent/providers/openai.ts](server/agent/providers/openai.ts)): tools grouped in a `namespace` tool, `store: false`, `stream: true`, no system messages / temperature / max_output_tokens (required by the ChatGPT plan route).
- `chatgpt-signin` follows OpenAI's official open-source "Sign in with ChatGPT" flow (developers.openai.com/siwc/token-sharing-open-source): `npm run chatgpt:login` does dynamic client registration + PKCE on `http://127.0.0.1:1455/auth/callback`, verifies the ID token via OIDC discovery, requires the `chatgpt.tokens.use.direct` scope, and saves `.chatgpt-credentials.json` (gitignored, 0600). Tokens refresh 5 minutes before expiry; one retry after a refresh on 401. Local use only (hosted apps need OpenAI approval); plan limits surface as an error, never a silent fallback.
- Consumer Claude logins cannot be used by third-party tools, so say "Claude via API key".

## Coding conventions

- TypeScript everywhere, strict mode, ESM. Node 20+ (team uses 24).
- No comments unless they explain a non-obvious why, one short line. No em dashes anywhere in code or strings.
- Use SDK types and helpers; do not hand-roll API shapes.
- Keep the content script small: never import zod or server code into `extension/src/content/`.
- Never commit `.env`. Check `git status` / `git diff --cached --stat` before every commit and push.
- Commit messages: one line, `type: short description`.

## Status and next steps

Done in this PoC: extension shell, WebSocket agent loop, tab tools, CSS/DOM/block engine with undo and View Transitions, per-site and global persistence, proactive page_load with blur and toast, injection blocking, before/after stats verification, demo pages.

Next, roughly in demo priority:
1. Real-site testing on the rehearsed demo sites (W3C BAD survey, Mars Commuter, Our World in Data); tune `read_page` outline size.
2. axe-core in `computeStats` for real issue counts in verification.
3. Gesture scrolling block (MediaPipe), with a recorded fallback clip.
4. Onboarding chat that builds the first profile; friction signals (zoom, misclicks) feeding proactive suggestions.
5. `openai-key` provider; latency work (cache per site and profile version, smaller model for page_load).
6. Stretch per PROJECT.md: Sentient connector, MongoDB library, Tiger Data dashboard.
