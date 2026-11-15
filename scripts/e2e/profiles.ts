import assert from "node:assert/strict";
import { buildExtension, launchBrowser, shadowTextVisible, waitFor } from "./lib.js";
import type { StoredState } from "../../extension/src/storage.js";

// Uses local saved layouts on two origins; no model calls or agent server required.
buildExtension();
const browser = await launchBrowser("profiles");
try {
  const panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/sidepanel.html`);
  await panel.evaluate(() => chrome.storage.local.set({ proactive: false, paused: false, profile: [] }));
  await browser.context.route("http://*.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: '<html><body><article><p class="game">Gaming video</p><p class="study">Study video</p></article></body></html>',
  }));
  const pages = await Promise.all(["http://first.test", "http://second.test"].map(async (url) => {
    const page = await browser.context.newPage();
    await page.goto(url);
    return page;
  }));
  await panel.evaluate(async () => {
    await chrome.storage.local.set({
      globalChanges: [{ id: "gaming-filter", summary: "Gaming layout", reason: "Gaming profile", css: ".study { display: none !important; }", dom: null, block: null, scope: "everywhere", appliedAt: Date.now() }],
      submittedRequests: ["Gaming request"],
    });
  });
  // A new profile starts empty, so it removes the previous layout in every tab.
  const create = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "profileAction", action: "create", name: "Study" }));
  assert.equal(create.ok, true);
  const studyId = await panel.evaluate(async () => (await chrome.storage.local.get("activeProfileId")).activeProfileId as string);
  for (const page of pages) await waitFor("empty Study layout", () => page.locator(".study").isVisible());
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ globalChanges: [{ id: "study-filter", summary: "Study layout", reason: "Study profile", css: ".game { display: none !important; }", dom: null, block: null, scope: "everywhere", appliedAt: Date.now() }], submittedRequests: ["Study request"] });
    await chrome.runtime.sendMessage({ kind: "profileAction", action: "switch", id: "default" });
  });
  for (const page of pages) {
    await waitFor("Gaming restored across websites", async () => await page.locator(".game").isVisible() && !await page.locator(".study").isVisible());
  }
  assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get("submittedRequests")).submittedRequests), ["Gaming request"]);
  await panel.evaluate((id) => chrome.runtime.sendMessage({ kind: "profileAction", action: "switch", id }), studyId);
  for (const page of pages) {
    await waitFor("Study restored across websites", async () => await page.locator(".study").isVisible() && !await page.locator(".game").isVisible());
    await page.reload();
    await waitFor("Study restored after navigation", async () => !await page.locator(".game").isVisible());
  }
  assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get("submittedRequests")).submittedRequests), ["Study request"]);
  const activeName = () => panel.evaluate(async () => {
    const { profiles, activeProfileId } = (await chrome.storage.local.get(["profiles", "activeProfileId"])) as { profiles: Record<string, { name: string }>; activeProfileId: string };
    return profiles[activeProfileId].name;
  });
  await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "profileAction", action: "create", name: "Fresh" }));
  await waitFor("empty profile selected", async () => (await activeName()) === "Fresh");
  assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get("submittedRequests")).submittedRequests), []);
  await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "profileAction", action: "rename", name: "Focus" }));
  await waitFor("renamed profile", async () => (await activeName()) === "Focus");
  await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "profileAction", action: "switch", id: "default" }));
  for (const page of pages) await waitFor("UI profile switch", async () => !await page.locator(".study").isVisible());

  const page = pages[0];
  await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://first.test/*" });
    await chrome.tabs.sendMessage(tabs[0].id!, { kind: "toggleSpotlight" });
  });
  const cdp = await browser.context.newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodes = function* (node: any): Generator<any> {
    yield node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) yield* nodes(child);
  };
  const input = [...nodes(root)].find((node) => node.nodeName === "INPUT" && node.attributes?.includes("input"));
  assert.ok(input, "Command bar input exists");
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: input.backendNodeId });
  const typeCommand = async (value: string, enter = false) => {
    await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId!,
      functionDeclaration: "function (value, enter) { this.focus(); this.value = value; this.dispatchEvent(new Event('input', { bubbles: true, composed: true })); if (enter) this.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); }",
      arguments: [{ value }, { value: enter }],
    });
  };
  await typeCommand("/profile");
  await waitFor("profile commands", () => shadowTextVisible(page, "New profile"));
  assert.equal(await shadowTextVisible(page, "Select profile: Default"), true);
  assert.equal(await shadowTextVisible(page, "New Gaming profile"), false);
  await page.screenshot({ path: "/tmp/browser-agent-profile-command.png" });
  await typeCommand("/profile new Personal", true);
  await waitFor("slash command creates profile", () => panel.evaluate(async () => {
    const state = await chrome.storage.local.get(["profiles", "activeProfileId", "profile", "globalChanges", "siteChanges"]) as StoredState;
    return state.profiles[state.activeProfileId]?.name === "Personal" && state.profile.length === 0 && state.globalChanges.length === 0 && Object.keys(state.siteChanges).length === 0;
  }));
  await typeCommand("/profile Default");
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId!,
    functionDeclaration: "function () { this.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); }",
  });
  await waitFor("slash command switches profile", () => panel.evaluate(async () => (await chrome.storage.local.get("activeProfileId")).activeProfileId === "default"));
  await typeCommand("/profile");
  await waitFor("rename command visible", () => shadowTextVisible(page, "Rename current profile"));
  await typeCommand("/profile rename My setup", true);
  await waitFor("slash command renames without switching", () => panel.evaluate(async () => {
    const state = await chrome.storage.local.get(["profiles", "activeProfileId", "submittedRequests"]) as StoredState;
    return state.activeProfileId === "default" && state.profiles.default.name === "My setup" && state.submittedRequests[0] === "Gaming request";
  }));
  await waitFor("renamed profile in command menu", () => shadowTextVisible(page, "Select profile: My setup"));
  for (const page of pages) assert.equal(await page.locator(".study").isVisible(), false);
  const clickProfileButton = async (label: string) => {
    await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId!,
      functionDeclaration: "function (label) { const button = [...this.getRootNode().querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label); if (!button) throw new Error('Missing button: ' + label); button.click(); }",
      arguments: [{ value: label }],
    });
  };
  await clickProfileButton("Delete profile: Study");
  assert.equal(await panel.evaluate(async (id) => Boolean(((await chrome.storage.local.get("profiles")) as StoredState).profiles[id]), studyId), true);
  await clickProfileButton("Cancel");
  assert.equal(await panel.evaluate(async (id) => Boolean(((await chrome.storage.local.get("profiles")) as StoredState).profiles[id]), studyId), true);
  await clickProfileButton("Delete profile: Study");
  await clickProfileButton("Confirm delete profile: Study");
  await waitFor("inactive profile deleted", () => panel.evaluate(async (id) => {
    const state = await chrome.storage.local.get(["profiles", "activeProfileId"]) as StoredState;
    return !state.profiles[id] && state.activeProfileId === "default";
  }, studyId));
  await waitFor("profile list refreshed", () => shadowTextVisible(page, "Select profile: My setup"));
  await clickProfileButton("Delete profile: My setup");
  await clickProfileButton("Confirm delete profile: My setup");
  await waitFor("active profile deleted and another selected", () => panel.evaluate(async () => {
    const state = await chrome.storage.local.get(["profiles", "activeProfileId"]) as StoredState;
    return !state.profiles.default && state.activeProfileId !== "default" && Boolean(state.profiles[state.activeProfileId]);
  }));
  for (const page of pages) await waitFor("deleted active layout removed", () => page.locator(".study").isVisible());
  const lastProfile = await panel.evaluate(async () => {
    const state = await chrome.storage.local.get(["profiles", "activeProfileId"]) as StoredState;
    for (const id of Object.keys(state.profiles)) if (id !== state.activeProfileId) await chrome.runtime.sendMessage({ kind: "profileAction", action: "delete", id });
    return chrome.runtime.sendMessage({ kind: "profileAction", action: "delete", id: state.activeProfileId });
  });
  assert.equal(lastProfile.ok, false, "The last remaining profile cannot be deleted");
  await cdp.detach();
  console.log("PASS profiles: independent layouts and history, cross-site switching, navigation persistence");
} finally {
  await browser.close();
}
