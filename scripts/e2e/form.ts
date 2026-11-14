import assert from "node:assert/strict";
import type { Change, PageOutline } from "../../shared/adaptation.js";
import type { ApplyOutcome } from "../../shared/protocol.js";
import { clickShadowButton, openDemo, openSidePanel, runE2E, sendChat, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("form", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/form.html");
  const panel = await openSidePanel(browser);
  const email = demo.locator("#email");
  const name = demo.locator("#name");
  const originalHeight = await email.evaluate((field) => field.getBoundingClientRect().height);

  const page: PageOutline = await panel.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    const response = await chrome.tabs.sendMessage(tab.id!, { kind: "tool", name: "read_page" });
    return response.result;
  }, demo.url());
  assert.equal(page.stats.inputsWithoutLabel, 2);

  const change: Change = {
    id: "form-audit",
    summary: "Audit form fixes",
    reason: "Form regression test",
    scope: "site",
    css: null,
    dom: null,
    block: { name: "formFixer", minTargetPx: 44, addLabels: true, clearErrors: true, oneQuestionMode: false },
  };
  const outcome: ApplyOutcome = await panel.evaluate(async ({ url, change }) => {
    const [tab] = await chrome.tabs.query({ url });
    const response = await chrome.tabs.sendMessage(tab.id!, { kind: "tool", name: "apply_change", input: { change } });
    await chrome.tabs.sendMessage(tab.id!, { kind: "tool", name: "revert_change", input: { id: change.id } });
    return response.result;
  }, { url: demo.url(), change });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.before.inputsWithoutLabel, 2);
  assert.equal(outcome.after.inputsWithoutLabel, 0);
  assert.match(outcome.note ?? "", /Axe checked visible form labels and tab order\. 0 issues remain\./);

  await sendChat(panel, demo, "Make this form easier, one question at a time");
  await waitFor("the form label", () => demo.locator('label[for="email"]').textContent({ timeout: 500 }).catch(() => null));
  assert.equal(await demo.locator('label[for="email"]').textContent(), "Email address");
  assert.equal(await email.getAttribute("tabindex"), null);
  assert.ok(await email.evaluate((field) => field.getBoundingClientRect().height) >= 44);
  assert.equal(await name.isVisible(), false);
  assert.equal(await demo.getByRole("button", { name: "Send" }).isVisible(), false);

  const next = demo.getByRole("button", { name: "Next" });
  await next.click();
  await waitFor("the inline form error", () => demo.getByRole("alert").textContent({ timeout: 500 }).catch(() => null));
  assert.ok(await email.getAttribute("aria-describedby"));
  await email.fill("test@example.com");
  await next.click();
  assert.equal(await name.isVisible(), true);
  assert.equal(await demo.locator('label[for="name"]').textContent(), "Full Name");
  assert.equal(await demo.getByRole("button", { name: "Send" }).isVisible(), true);

  await waitFor("the Undo button", () => shadowTextVisible(demo, "Undo"));
  await clickShadowButton(demo, "Undo");
  await waitFor("the generated labels to be removed", async () => (await demo.locator("form label").count()) === 0);
  assert.equal(await email.getAttribute("tabindex"), "2");
  assert.equal(await email.getAttribute("aria-describedby"), null);
  assert.equal(await email.evaluate((field) => field.getBoundingClientRect().height), originalHeight);
  assert.equal(await email.inputValue(), "test@example.com");
  assert.equal(await name.isVisible(), true);
});
