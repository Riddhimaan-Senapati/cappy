# Browser Agent

A Chrome side-panel chat that reads the current page, asks ChatGPT how to change it, and applies the resulting DOM edits directly in the tab. It works from page structure rather than site-specific video selectors.

Examples:

- **“Sort these YouTube videos by title A–Z.”**
- **“Sort these Instagram posts alphabetically by caption.”**
- **“Hide the sidebar and make the main content wider.”**
- **“Make this page dark with readable light text.”**
- **“Change this heading to My dashboard.”**
- **“Undo.”**

## Run locally

Requires Node.js 22+ and desktop Chrome 116+.

```sh
npm install
npm start
```

Keep the helper running, then:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository’s **extension/** directory.
3. Pin **Browser Agent**, open a website, and click the extension icon.
4. Choose **Continue with ChatGPT** and authorize ChatGPT plan usage on OpenAI’s website.
5. Return to the website, choose a model, and send a request.
6. For sites beyond YouTube, Chrome asks you to allow access to that site when you first send a request.

After updating this project, **restart `npm start`, reload Browser Agent at `chrome://extensions`, and refresh the website tab**. Existing ChatGPT login credentials remain saved. The helper and extension must both be on the current version.

## How page editing works

The extension captures a compact view of the current page when you send a message. It strips scripts, SVGs, hidden branches, form-field values, editable drafts, media data, long CSS class lists, and link query strings. It collapses unneeded single-child wrappers and prioritizes the main content before navigation.

Each retained element receives a temporary ID in the snapshot, without changing its real DOM attributes. A compact HTML tree preserves text, titles, image labels, links, structural relationships, and short semantic hints. The context is capped at approximately **24,000 characters / 6,000 estimated tokens**, with at most 450 elements. The panel shows the actual context size and whether it is partial. Token counts are estimates; exact tokenization and model reasoning/output usage vary.

The model receives your request, recent chat, and this compact HTML. It returns structured edit operations targeting snapshot IDs. The extension supports:

- Reorder existing cards/items, including across row wrappers.
- Hide elements.
- Change layout, colors, spacing, typography, and other supported inline styles.
- Replace the text of a text-only element.
- Insert simple text elements.
- Undo the latest batch of changes, with up to 20 batches retained per document.

All operations are checked before execution. Reordering moves original nodes so their images, links, and attached handlers stay together. Edits run only against the captured document and URL. The client rejects disconnected targets, stale snapshot IDs, unsupported operations, executable HTML, and external-resource CSS. Failed batches roll back completed operations. Page content is treated as data in the model instructions.

This deliberately does not evaluate arbitrary model-generated JavaScript. Chrome Manifest V3 restricts that approach; structured edits let the model direct page changes through a local executor.

## Scope and limits

Changes affect the local rendered page. They do not permanently edit your Instagram profile, publish posts, submit forms, or modify account settings. A page reload restores the website’s own rendering. A site’s framework may also rerender and overwrite a local change; send the request again to read its current state.

The model sees only the loaded elements included in the snapshot. If the context is partial, it edits that subset. Scroll or narrow your request to work with other content. New items loaded afterward are included on your next request; sorting is no longer tied to a YouTube-specific infinite-scroll watcher.

The generic DOM editor supports websites beyond YouTube, including Instagram-shaped feeds, but every site/layout is not guaranteed to work. Cross-origin iframe contents, canvas-only interfaces, closed shadow roots, browser-internal pages, and the Chrome Web Store are outside the captured document.

## Privacy and authentication

**Visible page text and structure are sent to OpenAI when you send a message.** Form-field values and contenteditable drafts are omitted, but private text already displayed on the page can be included. Snapshots are not saved to disk or chat history. Chrome grants access to additional websites individually; YouTube access is declared in the manifest. The `tabs` permission identifies the active website. Captured page context is never fetched in the background.

ChatGPT OAuth runs through the local Node helper because OpenAI’s documented open-source flow requires an HTTP loopback callback. No API key, client secret, copied cookies, or Codex installation is needed.

- Uses `dynamic_agent_client` registration, a stable host ID, fresh PKCE, state, and nonce.
- Verifies ID-token signature, issuer, audience, expiry, identity, and nonce.
- Retains each account’s issued client ID and refreshes expiring tokens with serialized refresh requests.
- Uses the signed-in account’s model catalog and public Responses API with `store: false` and `stream: true`.
- Waits for `response.completed` before accepting a model plan.
- Attempts session revocation at sign-out, then clears local tokens.

Tokens stay in `~/.config/browser-agent/credentials.json` with owner-only file permissions, outside browser storage and this repository. Set `BROWSER_AGENT_DATA_DIR` to use another directory. Recent chat is held in Chrome session storage and the selected model in extension local storage.

The helper listens on `127.0.0.1:3210` and checks the host, extension origin, and a custom header. The public `key` in `manifest.json` provides the extension’s stable ID; it is not a secret. Keep it unchanged unless you intend to change the extension ID.

ChatGPT plan/workspace eligibility and usage limits are enforced by OpenAI. Manage access in [ChatGPT usage settings](https://chatgpt.com/settings/usage).

## Sources

[Sentient OS](https://github.com/Sentient-OS-Labs/sentient-os) uses a private Codex runtime and Codex login. This project uses OpenAI’s documented public flow for open-source clients:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, refresh, and revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Chrome permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

## Checks

```sh
npm run check
npm test
```

Focused tests cover generic feed reordering, changed YouTube markup, snapshot size/privacy, main-content priority, reversible style/text/insertion/hiding, stale contexts, invalid operations, OAuth state checks, and streamed-response completion/failure. Browser smoke checks use isolated profiles and simulated model responses; a live OAuth/model check additionally requires a connected ChatGPT account.
