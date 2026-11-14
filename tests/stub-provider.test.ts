import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateChange, type PageOutline } from "../shared/adaptation.js";
import { planStubRun, stubSchedule, type StubCall } from "../server/agent/providers/stub.js";
import { describeProviders, resolveProvider } from "../server/agent/providers/index.js";

const page = (extra: Partial<PageOutline> = {}): PageOutline => ({
  url: "http://localhost:8787/demo/campus.html",
  title: "Campus",
  headings: [],
  elements: [],
  itemGroups: [],
  stats: { inputsWithoutLabel: 0, smallTargets: 0, smallText: 0, lowContrastText: 0, imagesWithoutAlt: 0, runningAnimations: 0, visibleAdsOrPopups: 0 },
  styleHints: { background: "#fff", color: "#000", fontSizePx: 12, fontFamily: "serif" },
  textSample: "",
  ...extra,
});

const chat = (message: string, extra: Partial<Parameters<typeof planStubRun>[0]> = {}) =>
  planStubRun({ trigger: "chat", message, profile: [], page: page(), ...extra });

const applied = (calls: StubCall[]) => calls.flatMap((call) => (call.name === "apply_change" ? [call.input.change] : []));

describe("stub provider routing", () => {
  it("maps text size requests to a textScale block", () => {
    for (const message of ["make the text bigger", "bigger text please", "larger text", "text larger"]) {
      const [change] = applied(chat(message).calls);
      assert.equal(change?.id, "bigger-text", message);
      assert.deepEqual(change?.block, { name: "textScale", scale: 1.3 }, message);
    }
  });

  it("maps dark mode to the darkMode block with site controls", () => {
    const [change] = applied(chat("turn on dark mode").calls);
    assert.deepEqual(change?.block, { name: "darkMode", allowSiteControls: true });
  });

  it("maps invert to a CSS filter", () => {
    const [change] = applied(chat("invert this page").calls);
    assert.equal(change?.css, "html { filter: invert(1) hue-rotate(180deg); }");
    assert.equal(change?.block, null);
  });

  it("hides a word with singular and plural keywords and no item selector when the outline has no item groups", () => {
    const [change] = applied(chat("remove all ads").calls);
    assert.equal(change?.id, "hide-ads");
    assert.deepEqual(change?.block, { name: "contentFilter", keywords: ["ads", "ad"], itemSelector: null, action: "hide" });
  });

  it("uses the first itemGroup whose samples mention the word", () => {
    const outline = page({
      itemGroups: [
        { selector: ".story", count: 3, samples: ["Local news"] },
        { selector: ".promo-card", count: 2, samples: ["Sponsored: Ad-free plan"] },
      ],
    });
    const [change] = applied(planStubRun({ trigger: "chat", message: "hide ads", profile: [], page: outline }).calls);
    assert.equal(change?.block && change.block.name === "contentFilter" ? change.block.itemSelector : undefined, ".promo-card");
  });

  it("hides popups with the singular and plural keyword forms", () => {
    const [change] = applied(chat("hide popups").calls);
    assert.deepEqual(change?.block, { name: "contentFilter", keywords: ["popups", "popup"], itemSelector: null, action: "hide" });
  });

  it("applies a deuteranopia filter and remembers red-green colorblindness", () => {
    const plan = chat("I'm red-green colorblind");
    const [change] = applied(plan.calls);
    assert.deepEqual(change?.block, { name: "colorblind", type: "deuteranopia", scope: "media" });
    assert.deepEqual(plan.calls.at(-1), { name: "remember", input: { lines: ["Red-green colorblind"], scope: "everywhere" } });
  });

  it("reads time windows and day sets into a schedule on the filter", () => {
    assert.deepEqual(stubSchedule("hide podcasts between 9am and 5pm"), { days: null, start: "09:00", end: "17:00" });
    assert.deepEqual(stubSchedule("hide shorts from 22:30 to 6 on weekdays"), { days: ["mon", "tue", "wed", "thu", "fri"], start: "22:30", end: "06:00" });
    assert.deepEqual(stubSchedule("hide podcasts on weekends"), { days: ["sat", "sun"], start: null, end: null });
    assert.equal(stubSchedule("hide podcasts"), null);
    const [call] = applied(chat("hide podcasts between 12am and 11pm").calls);
    assert.deepEqual(call.schedule, { days: null, start: "00:00", end: "23:00" });
  });

  it("offers options instead of guessing on a vague request", () => {
    const plan = chat("make this easier to read");
    assert.equal(plan.calls.length, 1);
    const [call] = plan.calls;
    assert.equal(call.name, "offer_options");
    assert.deepEqual(call.name === "offer_options" ? call.input.options.map(({ label }) => label) : [], ["Larger text", "Dark mode", "Hide clutter"]);
  });

  it("remembers preference statements without applying a change", () => {
    const plan = chat("I prefer high contrast menus");
    assert.deepEqual(applied(plan.calls), []);
    assert.deepEqual(plan.calls, [{ name: "remember", input: { lines: ["I prefer high contrast menus"], scope: "everywhere" } }]);
  });

  it("applies larger text on page_load when the profile asks for it", () => {
    const plan = planStubRun({ trigger: "page_load", message: "", profile: ["Prefers larger text"], page: page() });
    assert.equal(applied(plan.calls)[0]?.block && applied(plan.calls)[0].block?.name, "textScale");
    assert.equal(plan.reply, "Applied larger text from your profile.");
  });

  it("makes no change on page_load when the profile has nothing for this page", () => {
    const plan = planStubRun({ trigger: "page_load", message: "", profile: ["Red-green colorblind"], page: page() });
    assert.deepEqual(plan.calls, []);
    assert.equal(plan.reply, "");
  });

  it("makes no change for an unmatched request and says what it understands", () => {
    const plan = chat("write me a poem");
    assert.deepEqual(plan.calls, []);
    assert.match(plan.reply, /no scripted rule matched/);
  });

  it("only produces changes that pass the shared validator", () => {
    const messages = ["make the text bigger", "dark mode", "invert", "hide ads", "colorblind", "remove all popups"];
    for (const message of messages) {
      for (const change of applied(chat(message).calls)) {
        assert.equal(validateChange(change), null, `${message}: ${change.id}`);
      }
    }
  });
});

describe("provider registry", () => {
  it("selects the stub provider with LLM_PROVIDER=stub and needs no key", () => {
    const previous = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "stub";
    try {
      const provider = resolveProvider();
      assert.equal(provider?.name, "stub");
      assert.deepEqual(provider?.models, { fast: "stub-fast", frontier: "stub-frontier" });
    } finally {
      if (previous === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = previous;
    }
  });

  it("never offers the stub in settings unless it was requested", async () => {
    const previous = process.env.LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    try {
      const ids = (await describeProviders()).map(({ id }) => id);
      assert.deepEqual(ids, ["chatgpt-signin", "anthropic-key", "openai-key", "gemini"]);
    } finally {
      if (previous !== undefined) process.env.LLM_PROVIDER = previous;
    }
  });
});
