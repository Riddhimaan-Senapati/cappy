# LLM providers (backend)

Paste this section into `CLAUDE.md` (or keep as `docs/llm-providers.md` and link it from `CLAUDE.md`).

## Goal

The backend talks to models only through one `LLMProvider` interface. **Gemini with an API key is the default and the one we pitch** (MLH Best Use of Gemini API). Other providers exist so the team can test on accounts they already have. The safety layer, verification loop and extension must not know which provider is active.

## Interface

```ts
interface LLMProvider {
  id: "gemini" | "openai-key" | "anthropic-key" | "chatgpt-signin";
  // Pick an adaptation for this page. Output MUST validate against the adaptation schema.
  proposeAdaptation(input: {
    profileSummary: string;      // short summary only, never raw notes or messages
    url: string;
    pageOutline: string;         // untrusted text, fenced
  }): Promise<Adaptation>;
  // Judge before/after screenshots. Returns a verdict, not free text.
  judgeChange(input: {
    before: Buffer; after: Buffer; goal: string;
  }): Promise<{ ok: boolean; reason: string }>;
  // Optional: alt text for images (stretch block).
  describeImage?(img: Buffer): Promise<string>;
}
```

Select with env `LLM_PROVIDER` (default `gemini`). Missing credentials for the chosen provider fail fast at startup with a clear message. Never fall back to another provider silently mid-request.

## Providers

| id | Auth | Status | Notes |
|---|---|---|---|
| `gemini` | `GEMINI_API_KEY` | Default, must work | Fast model (e.g. gemini-2.5-flash; check what is current). Structured JSON output with the adaptation schema. |
| `openai-key` | `OPENAI_API_KEY` | Easy backup | Structured output with the same schema. |
| `anthropic-key` | `ANTHROPIC_API_KEY` | Easy backup | API key only. See "Claude accounts" below. |
| `chatgpt-signin` | ChatGPT Plus or Pro login | Experimental, local testing only | See below. |

API keys live only in the backend environment, never in the extension, never committed.

## `chatgpt-signin` (experimental)

Lets a developer test with a ChatGPT Plus or Pro plan instead of an API key. Based on OpenAI's "Sign in with ChatGPT / use your ChatGPT plan" feature. Facts as reported by third-party write-ups (not verified against OpenAI's own docs; check before relying on it):

- OpenAI allows **local, open-source tools** to use a user's plan without partner approval. Hosted apps need approval, so this provider is for the local backend only.
- Flow: OAuth with PKCE (S256) and a random `state`, opened in the system browser. The redirect goes to **`http://127.0.0.1:<port>/...`** (not `localhost`; only the port may vary). Request the `chatgpt.tokens.use.direct` scope and confirm it appears in the token response.
- Store tokens in the OS credential store or a gitignored local file. Never log them. Refresh shortly before expiry; share one refresh between concurrent requests; on a `401`, refresh once and retry once; on a fatal auth failure, clear the credentials and ask the user to sign in again. Persist any rotated refresh token before continuing.
- Do **not** read another app's token files (for example Codex's auth file) and do not ask users to paste tokens.
- Request restrictions: no `system` message, no `temperature`, no `max_output_tokens`, no hosted tools (file search, image generation).
- **Consequence for us:** put instructions and the fenced untrusted page outline in the user message, and rely on strict schema validation of the output (already required for all providers) as the main injection defense.
- Limits: Plus has a five-hour usage limit shared with all connected apps; when it is hit, requests stop and nothing falls back automatically. Surface a clear "plan limit reached" error and tell the developer to switch `LLM_PROVIDER`.
- **TODO (needs research, not yet known):** exact authorization and token URLs, client ID, request endpoint and body format, which models are allowed. Find them in OpenAI's official help article "Using your ChatGPT plan in other apps and sites" (help.openai.com article 20001542) and the open-source Codex code. Do not guess values.
- Experimental: OpenAI has no contract with us and this can break. It is never the demo path; the demo uses `gemini`.

## Claude accounts

Anthropic does **not** allow Claude Free, Pro or Max subscription logins in any other tool or script, including the Agent SDK (Consumer Terms; confirmed in Anthropic's updated compliance page as reported by The Register, Feb 2026). So there is no "sign in with Claude" provider. Claude support means `anthropic-key` with an API key billed per token. In the pitch and write-up say "Claude via API key", never "Claude accounts". Do not shell out to `claude -p` with a subscription login either.

## Rules that hold for every provider

1. Output must validate against the adaptation schema; unknown fields, blocks or elements are rejected. The model never writes code.
2. Page text is untrusted data, fenced and labeled as such in the prompt.
3. Only the short profile summary is sent, never raw notes or messages.
4. Same schema, same safety layer, same verification loop regardless of provider.
5. Log which provider answered each request (without logging prompts that contain user data).

## Pitch wording

"Gemini by default. Also works with OpenAI and, for local testing, a ChatGPT Plus sign-in; Claude via API key."
