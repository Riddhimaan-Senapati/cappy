import assert from "node:assert/strict";
import type { CDPSession, Page } from "playwright";
import { fontSizeOf, openDemo, runE2E, shadowTextVisible, waitFor } from "./lib.js";

// The request from issue #17. The stub has no rule for it, so a wrong submit of the zoom suggestion is visible as larger text.
const REQUEST = "label every control so a screen reader can find it";

interface DomNode {
  nodeName: string;
  nodeValue?: string;
  nodeType: number;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

function* walk(node: DomNode): Generator<DomNode> {
  yield node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) yield* walk(child);
}

function attr(node: DomNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

async function rootOf(session: CDPSession): Promise<DomNode> {
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  return root;
}

async function barState(page: Page): Promise<{ open: boolean; suggestion: boolean; selected: boolean }> {
  const session = await page.context().newCDPSession(page);
  try {
    const root = await rootOf(session);
    let open = false;
    let suggestion = false;
    let selected = false;
    for (const node of walk(root)) {
      if (node.nodeType === 3 && node.nodeValue?.includes("make the text bigger")) suggestion = true;
      const classes = (attr(node, "class") ?? "").split(/\s+/);
      if (classes.includes("sp") && classes.includes("open")) open = true;
      if (attr(node, "aria-selected") === "true") selected = true;
    }
    return { open, suggestion, selected };
  } finally {
    await session.detach();
  }
}

await runE2E("bar-enter", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const [worker] = browser.context.serviceWorkers();
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((candidate) => candidate.url === url);
    return tab?.id;
  }, demo.url());
  assert.ok(tabId !== undefined, "Demo tab is registered in Chromium");

  await demo.bringToFront();
  await worker.evaluate(async (id) => {
    await chrome.tabs.setZoom(id, 1);
    await chrome.tabs.setZoom(id, 1.1);
    await chrome.tabs.setZoom(id, 1.25);
  }, tabId);
  await waitFor("the noticed-friction suggestion", () => shadowTextVisible(demo, "make the text bigger"));

  const before = await fontSizeOf(demo);
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { kind: "toggleSpotlight" }), tabId);
  await waitFor("the suggestion listed and not selected", async () => {
    const state = await barState(demo);
    return state.open && state.suggestion && !state.selected;
  });

  const session = await demo.context().newCDPSession(demo);
  try {
    const root = await rootOf(session);
    const input = [...walk(root)].find((node) => node.nodeName === "INPUT" && (attr(node, "class") ?? "").split(/\s+/).includes("input"));
    assert.ok(input, "Command bar input exists");
    const { object } = (await session.send("DOM.resolveNode", { backendNodeId: input.backendNodeId })) as { object: { objectId?: string } };
    assert.ok(object.objectId, "Command bar input can be focused");
    await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function () { this.focus(); }",
    });
    await session.send("DOM.focus", { backendNodeId: input.backendNodeId });
    await session.send("Input.insertText", { text: REQUEST });
    const read = (await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function () { return this.value; }",
      returnByValue: true,
    })) as { result?: { value?: string } };
    assert.equal(read.result?.value, REQUEST);
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
  } finally {
    await session.detach();
  }

  await waitFor("the typed request in the bar", () => shadowTextVisible(demo, REQUEST));
  await waitFor("the stub answered the typed request", () => shadowTextVisible(demo, "no scripted rule matched"));
  assert.equal(await fontSizeOf(demo), before, "the zoom suggestion did not run");
});
