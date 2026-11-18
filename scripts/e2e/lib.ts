import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXTENSION_DIR = path.join(ROOT, "extension");
export const PORT = 8787;
export const BASE_URL = `http://localhost:${PORT}`;
const BUN = process.execPath.includes("bun") ? process.execPath : "bun";

export function buildExtension() {
  if (process.env.E2E_SKIP_BUILD === "1") return;
  execFileSync("bun", ["run", "build:ext"], { cwd: ROOT, stdio: "inherit" });
}

const accepts = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });

// localhost may resolve to IPv4 or IPv6, so a server on either one would capture the extension's connection.
async function assertPortFree(port: number) {
  const taken = await Promise.all(["127.0.0.1", "::1"].map((host) => accepts(host, port)));
  if (taken.some(Boolean)) {
    throw new Error(`Port ${port} is already in use (IPv4 or IPv6). Stop the process on it (for example bun run dev) and re-run. The e2e harness will not reuse another server.`);
  }
}

export interface ServerProcess {
  stop(): Promise<void>;
  output(): string;
}

// Starts the real agent server with the deterministic stub provider on port 8787.
export async function startServer(): Promise<ServerProcess> {
  await assertPortFree(PORT);
  const logs: string[] = [];
  const child: ChildProcess = spawn(BUN, ["server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, LLM_PROVIDER: "stub", PORT: String(PORT), CAPPY_TRUST_ANY_EXTENSION: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    const earlyExit = await Promise.race<{ code: number | null } | null>([
      exited.then((code) => ({ code })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    if (earlyExit) throw new Error(`Agent server exited with code ${earlyExit.code} before it was ready:\n${logs.join("")}`);
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`Agent server did not become ready on ${BASE_URL}:\n${logs.join("")}`);
    }
  }

  let stopped = false;
  return {
    output: () => logs.join(""),
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      await exited;
    },
  };
}

export interface Browser {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
}

export async function launchBrowser(name: string, options: E2EOptions = {}): Promise<Browser> {
  if (!existsSync(path.join(EXTENSION_DIR, "manifest.json"))) throw new Error(`No extension manifest at ${EXTENSION_DIR}`);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `ba-e2e-${name}-`));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: process.env.E2E_HEADED !== "1",
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, "--no-first-run", "--no-default-browser-check",
      ...(options.fakeAudio ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${options.fakeAudio}`] : []),
    ],
  });
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  // A fresh install opens the setup page; tests that query the active tab would otherwise hit it.
  await worker.evaluate(() => chrome.storage.local.set({ onboarded: true }));
  const welcome = await context.waitForEvent("page", { predicate: (page) => page.url().includes("/welcome.html"), timeout: 3_000 }).catch(() => context.pages().find((page) => page.url().includes("/welcome.html")));
  await welcome?.close();
  return {
    context,
    extensionId,
    async close() {
      await context.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function openSidePanel(browser: Browser): Promise<Page> {
  const panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/sidepanel.html`);
  await panel.waitForSelector("textarea");
  return panel;
}

export async function openDemo(browser: Browser, route: string): Promise<Page> {
  const page = await browser.context.newPage();
  await page.goto(`${BASE_URL}${route}`);
  await page.waitForLoadState("load");
  return page;
}

// The side panel acts on the last focused window's active tab, so the demo tab must be in front when the message is sent.
export async function sendChat(panel: Page, demo: Page, message: string) {
  await panel.bringToFront();
  await panel.fill("textarea", message);
  await demo.bringToFront();
  await panel.getByRole("button", { name: "Send", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
}

export async function waitFor<T>(description: string, read: () => Promise<T | undefined | false | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}${last ? `: ${String(last)}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function fontSizeOf(page: Page, selector = "article p"): Promise<number> {
  return page.evaluate((query) => parseFloat(getComputedStyle(document.querySelector(query) as Element).fontSize), selector);
}

// Serves /demo/* from disk for this origin, so pages still load after the agent server is stopped.
export async function serveDemoFromDisk(browser: Browser) {
  const demoDir = path.join(ROOT, "demo-sites");
  await browser.context.route(`${BASE_URL}/demo/**`, async (route) => {
    const file = path.join(demoDir, path.basename(new URL(route.request().url()).pathname));
    await route.fulfill({ path: file, contentType: "text/html; charset=utf-8" });
  });
}

// Toast and spotlight live in a closed shadow root, which page scripts cannot reach. CDP can, so we pierce it here.
interface DomNode {
  nodeName: string;
  nodeValue?: string;
  nodeType: number;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

function* walk(node: DomNode): Generator<DomNode> {
  yield node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
    yield* walk(child);
  }
}

function textOf(node: DomNode): string {
  let text = "";
  for (const part of walk(node)) if (part.nodeType === 3) text += part.nodeValue ?? "";
  return text.trim();
}

async function pierce(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  return { session, root };
}

function attr(node: DomNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

async function ensureAttrs(session: CDPSession, node: DomNode) {
  if (node.attributes) return;
  const described = (await session.send("DOM.describeNode", { backendNodeId: node.backendNodeId })) as { node: DomNode };
  node.attributes = described.node.attributes ?? [];
}

async function resolveAndCall(session: CDPSession, node: DomNode, source: string, args: unknown[] = []) {
  const { object } = (await session.send("DOM.resolveNode", { backendNodeId: node.backendNodeId })) as { object: { objectId?: string } };
  if (!object.objectId) throw new Error("Could not resolve an extension UI node");
  const result = (await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: source,
    arguments: args.map((value) => ({ value })),
    awaitPromise: false,
  })) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "extension UI call failed");
}

// Plain Enter in the bar replays a saved request. The side panel always asks the model again.
export async function askInBar(page: Page, message: string): Promise<void> {
  await page.bringToFront();
  const opened = await pierce(page);
  try {
    let fab: DomNode | undefined;
    for (const node of walk(opened.root)) {
      if (node.nodeName !== "BUTTON") continue;
      await ensureAttrs(opened.session, node);
      if ((attr(node, "aria-label") ?? "").includes("Open Cappy")) fab = node;
    }
    if (!fab) throw new Error("No Cappy button on the page");
    await resolveAndCall(opened.session, fab, "function () { this.click(); }");
  } finally {
    await opened.session.detach();
  }

  await waitFor("the bar to open", async () => {
    const { session, root } = await pierce(page);
    try {
      for (const node of walk(root)) {
        if (node.nodeName !== "DIV") continue;
        await ensureAttrs(session, node);
        const classes = (attr(node, "class") ?? "").split(/\s+/);
        if (classes.includes("sp") && classes.includes("open")) return true;
      }
      return false;
    } finally {
      await session.detach();
    }
  });

  const typing = await pierce(page);
  try {
    let input: DomNode | undefined;
    for (const node of walk(typing.root)) {
      if (node.nodeName !== "INPUT") continue;
      await ensureAttrs(typing.session, node);
      if ((attr(node, "class") ?? "").split(/\s+/).includes("input")) input = node;
    }
    if (!input) throw new Error("The bar has no request field");
    await resolveAndCall(
      typing.session,
      input,
      `function (message) {
        this.focus();
        this.value = message;
        this.dispatchEvent(new Event("input", { bubbles: true }));
      }`,
      [message],
    );
    await page.keyboard.press("Enter");
  } finally {
    await typing.session.detach();
  }
}

export async function shadowButtonVisible(page: Page, label: string): Promise<boolean> {
  const { session, root } = await pierce(page);
  try {
    for (const node of walk(root)) if (node.nodeName === "BUTTON" && textOf(node) === label) return true;
    return false;
  } finally {
    await session.detach();
  }
}

// True when an element with this class exists in the extension's shadow UI and has no hidden attribute.
export async function shadowClassShown(page: Page, className: string): Promise<boolean> {
  const { session, root } = await pierce(page);
  try {
    for (const node of walk(root)) {
      if (node.nodeType !== 1) continue;
      await ensureAttrs(session, node);
      if ((attr(node, "class") ?? "").split(/\s+/).includes(className)) return attr(node, "hidden") == null;
    }
    return false;
  } finally {
    await session.detach();
  }
}

export async function shadowTextVisible(page: Page, fragment: string): Promise<boolean> {
  const { session, root } = await pierce(page);
  try {
    for (const node of walk(root)) if (node.nodeType === 3 && node.nodeValue?.includes(fragment)) return true;
    return false;
  } finally {
    await session.detach();
  }
}

// Clicks the last button with this label inside the extension's shadow UI (the toast, for example).
export async function clickShadowButton(page: Page, label: string): Promise<void> {
  const { session, root } = await pierce(page);
  try {
    let target: DomNode | undefined;
    for (const node of walk(root)) if (node.nodeName === "BUTTON" && textOf(node) === label) target = node;
    if (!target) throw new Error(`No "${label}" button in the page's extension UI`);
    const { object } = (await session.send("DOM.resolveNode", { backendNodeId: target.backendNodeId })) as { object: { objectId?: string } };
    if (!object.objectId) throw new Error(`Could not resolve the "${label}" button`);
    await session.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { this.click(); }", awaitPromise: false });
  } finally {
    await session.detach();
  }
}

// Runs one e2e test, prints PASS or FAIL, and always tears down the server and browser it created.
export interface E2EOptions {
  // A WAV file Chromium plays as the microphone.
  fakeAudio?: string;
}

export async function runE2E(name: string, body: (ctx: { server: ServerProcess; browser: Browser }) => Promise<void>, options: E2EOptions = {}) {
  let server: ServerProcess | undefined;
  let browser: Browser | undefined;
  try {
    buildExtension();
    server = await startServer();
    browser = await launchBrowser(name, options);
    await body({ server, browser });
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    const serverLog = server?.output();
    if (serverLog) console.log(`--- server output ---\n${serverLog}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await server?.stop();
  }
}
