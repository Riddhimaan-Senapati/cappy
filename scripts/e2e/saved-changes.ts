import assert from "node:assert/strict";
import zlib from "node:zlib";
import { clickShadowText, openBar } from "./bar.js";
import { askInBar, clickShadowButton, fontSizeOf, openDemo, runE2E, shadowButtonVisible, shadowTextVisible, waitFor } from "./lib.js";

const ORIGIN = "http://localhost:8787";

function pngPixels(buf: Buffer): { width: number; height: number; channels: number; data: Buffer } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 2;
  const idats: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? 2;
    } else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let src = 0;
  let prev = Buffer.alloc(stride);
  const paeth = (left: number, up: number, ul: number) => {
    const p = left + up - ul;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - ul);
    return pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[src++] ?? 0;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] ?? 0;
      const left = i >= channels ? recon[i - channels]! : 0;
      const up = prev[i]!;
      const ul = i >= channels ? prev[i - channels]! : 0;
      const add = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, ul) : 0;
      recon[i] = (x + add) & 255;
    }
    src += stride;
    recon.copy(out, y * stride);
    prev = recon;
  }
  return { width, height, channels, data: out };
}

await runE2E("saved-changes", async ({ browser }) => {
  const campus = await openDemo(browser, "/demo/campus.html");
  const before = await fontSizeOf(campus);
  await askInBar(campus, "make the text bigger");
  await waitFor("paragraph font-size to grow", async () => ((await fontSizeOf(campus)) >= before * 1.25 ? true : undefined));
  await waitFor("the bar to finish the text request", () => shadowTextVisible(campus, "Stub: made the text larger"));

  const form = await openDemo(browser, "/demo/form.html");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const leaked = await form.evaluate(() => [...document.querySelectorAll<HTMLElement>("h1, p, input, button")].some((element) => element.style.fontSize !== ""));
    assert.equal(leaked, false, "larger text from campus was applied on the form page");
    await form.waitForTimeout(200);
  }
  await openBar(form);
  assert.equal(await shadowTextVisible(form, "Undo larger text"), false, "the bar offers undo for a change that was not applied here");
  assert.equal(await shadowTextVisible(form, "Undo dark mode"), false);

  await campus.bringToFront();
  if (await shadowButtonVisible(campus, "Undo")) await clickShadowButton(campus, "Undo");
  else {
    await openBar(campus);
    await clickShadowText(campus, "Undo larger text");
  }
  await waitFor("the campus text to return", async () => (Math.abs((await fontSizeOf(campus)) - before) <= 0.5 ? true : undefined));
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
  await waitFor("undo to drop the saved change and the recipe", () => worker.evaluate(async (origin) => {
    const data = await chrome.storage.local.get(["recipes", "siteChanges", "globalChanges"]) as {
      recipes?: Record<string, { changes?: Array<{ id: string }> }>;
      siteChanges?: Record<string, Array<{ id: string }>>;
      globalChanges?: Array<{ id: string }>;
    };
    const recipes = data.recipes || {};
    const site = (data.siteChanges && data.siteChanges[origin]) || [];
    const globalChanges = data.globalChanges || [];
    const recipe = recipes[origin + "::make the text bigger"];
    const changes = (recipe && recipe.changes) || [];
    let kept = false;
    let stored = false;
    for (const change of changes) {
      if (change.id === "bigger-text" || change.id.indexOf("bigger-text-") === 0) kept = true;
    }
    for (const change of site.concat(globalChanges)) {
      if (change.id === "bigger-text" || change.id.indexOf("bigger-text-") === 0) stored = true;
    }
    return !kept && !stored ? true : undefined;
  }, ORIGIN));

  await campus.reload();
  await campus.waitForLoadState("load");
  const reloaded = Date.now() + 2000;
  while (Date.now() < reloaded) {
    const size = await fontSizeOf(campus);
    assert.ok(Math.abs(size - before) <= 0.5, `undo left the larger text to restore on reload (${size}px, was ${before}px)`);
    await campus.waitForTimeout(200);
  }

  await askInBar(campus, "make the text bigger");
  await waitFor("the model to answer instead of the saved recipe", () => shadowTextVisible(campus, "Stub: made the text larger"));
  assert.equal(await shadowTextVisible(campus, "from your saved version"), false);

  const dark = await openDemo(browser, "/demo/dark-none.html");
  await askInBar(dark, "dark mode");
  await waitFor("dark mode to invert the page", () => dark.evaluate(() => document.querySelector("style[data-ba='dark-mode']")?.textContent?.includes("invert(1)") ?? false));
  const css = await dark.evaluate(() => document.querySelector("style[data-ba='dark-mode']")?.textContent ?? "");
  assert.equal(css.includes("hue-rotate"), false);
  const box = await dark.locator("img").boundingBox();
  assert.ok(box);
  const shot = await dark.screenshot({ clip: { x: box.x + 25, y: box.y + 25, width: 6, height: 6 } });
  const whiteShot = await dark.screenshot({ clip: { x: box.x + 90, y: box.y + 20, width: 6, height: 6 } });
  const red = pngPixels(shot);
  const white = pngPixels(whiteShot);
  const redPixel = [red.data[0]!, red.data[1]!, red.data[2]!];
  const whitePixel = [white.data[0]!, white.data[1]!, white.data[2]!];
  assert.ok(redPixel[0] > 170 && redPixel[1] < 40 && redPixel[2] < 40, `red square rendered as ${redPixel.join(",")}`);
  assert.ok(whitePixel.every((channel) => channel > 220), `image background rendered as ${whitePixel.join(",")}`);

  for (const route of ["/demo/form.html", "/demo/trap.html"]) {
    const page = await openDemo(browser, route);
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const marks = await page.evaluate(() => document.querySelectorAll("style[data-ba='dark-mode']").length);
      assert.equal(marks, 0, `dark mode carried over to ${route}`);
      await page.waitForTimeout(200);
    }
  }
});
