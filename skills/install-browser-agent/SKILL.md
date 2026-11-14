---
name: install-browser-agent
description: >-
  Install and run the browser-agent Chrome extension and its local server.
  Use when asked to set up, install, or run browser-agent.
license: MIT
---

# Install browser-agent

browser-agent is a Chrome extension plus a local server. The server holds the API keys. The extension changes the page the user is on. It does not click, type, or navigate for them.

Follow the steps in order. Run each command and report what it prints.

## 1. Check bun

```bash
bun --version
```

If bun is missing, stop and tell the user to install bun from https://bun.sh.

## 2. Get the repo

If the current directory is already the browser-agent checkout, stay there. Otherwise clone it and enter it.

```bash
git clone https://github.com/Riddhimaan-Senapati/browser-agent.git
cd browser-agent
```

## 3. Install dependencies

```bash
bun install
```

## 4. Start the server and the extension build

The server listens on port 8787 unless `PORT` is set. That port has to be free on `127.0.0.1` and on `::1`. If something else is listening, stop and name the process. Do not pick a different port unless the user asks.

```bash
bun run dev
```

Leave this process running. It builds the extension, starts the server, and rebuilds the extension when files change.

The server prints both of these lines when it is up:

```text
browser-agent server on http://localhost:8787
demo site: http://localhost:8787/demo/campus.html
```

## 5. Load the extension

You cannot finish this step. Tell the user to do it.

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked and choose the `extension/` directory in this checkout.
4. Open the extension popup. Sign in with ChatGPT, or add a Claude, OpenAI, or Gemini key.

Keys stay on the server, in files the repo ignores. Do not copy a key into the extension, into chat, or into a commit.

## 6. Check that it answers

In another shell, with `bun run dev` still running:

```bash
curl -fsS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT:-8787}/demo/campus.html"
```

The status is `200`. Then tell the user to open that demo page and press Ctrl+Shift+Space, or Cmd+Shift+Space on macOS. That opens the bar.

## When something fails

- Port 8787 is taken. Free it, then repeat step 4. Do not start a second copy.
- `bun` is missing. Install bun, then repeat step 1.
- The popup has no provider. The server has to be running, and the user still has to sign in or add a key.
- `curl` cannot connect. `bun run dev` is not running, or `PORT` is not 8787. Use the port the server printed.
