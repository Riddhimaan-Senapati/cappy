import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { BlockOf } from "@browser-agent/shared";
import { applyFormFixer } from "./form-fixer";

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

const cfg = (overrides: Partial<BlockOf<"form_fixer">> = {}): BlockOf<"form_fixer"> => ({
  block: "form_fixer",
  addLabels: true,
  clearErrors: true,
  minTargetPx: 44,
  oneQuestionMode: false,
  ...overrides,
});

const labelFor = (id: string): string | null =>
  Array.from(document.querySelectorAll("label")).find((l) => l.getAttribute("for") === id)?.textContent ?? null;

describe("form fixer: labels", () => {
  test("adds labels from placeholder, then name, and keeps named fields alone", () => {
    document.body.innerHTML = `
      <form>
        <input name="first_name">
        <input type="email" placeholder="Email address">
        <input name="city" aria-label="City already named">
      </form>`;
    applyFormFixer(cfg({ clearErrors: false, minTargetPx: 24 }));

    const [first, email, city] = Array.from(document.querySelectorAll("input"));
    expect(labelFor(first!.id)).toBe("First name");
    expect(labelFor(email!.id)).toBe("Email address");
    expect(city!.id).toBe("");
    expect(document.querySelectorAll("label").length).toBe(2);
  });

  test("undo restores the original DOM exactly", () => {
    document.body.innerHTML = `
      <form>
        <input name="first_name" tabindex="2" class="x" required>
        <a href="#skip" tabindex="5">Skip</a>
        <input type="email" placeholder="Email address">
        <button>Send</button>
      </form>`;
    const before = document.body.innerHTML;
    const undo = applyFormFixer(cfg({ oneQuestionMode: true }));
    expect(document.body.innerHTML).not.toBe(before);
    undo();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe("form fixer: tab order", () => {
  test("removes positive tabindex values and restores them on undo", () => {
    document.body.innerHTML = `<form><a href="#x" tabindex="3">A</a><input name="q" tabindex="0"></form>`;
    const link = document.querySelector("a")!;
    const undo = applyFormFixer(cfg({ addLabels: false, clearErrors: false, oneQuestionMode: false, minTargetPx: 24 }));

    expect(link.hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector("input")!.getAttribute("tabindex")).toBe("0");

    undo();
    expect(link.getAttribute("tabindex")).toBe("3");
  });
});

describe("form fixer: one question at a time", () => {
  test("shows one field group at a time and walks through with Next and Back", () => {
    document.body.innerHTML = `
      <form>
        <input name="first_name" required>
        <input name="last_name">
        <input name="email" type="email">
        <button type="submit">Send</button>
      </form>`;
    const undo = applyFormFixer(cfg({ oneQuestionMode: true, clearErrors: false }));

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs.map((i) => i.hidden)).toEqual([false, true, true]);
    expect(document.querySelector<HTMLButtonElement>("button[type=submit]")!.hidden).toBe(true);

    const [back, nextBtn] = Array.from(document.querySelectorAll<HTMLButtonElement>(".ab-wizard-nav button"));
    if (!back || !nextBtn) throw new Error("wizard nav missing");
    expect(back.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(true);

    inputs[0]!.value = "Ada";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(nextBtn.disabled).toBe(false);

    nextBtn.click();
    expect(inputs.map((i) => i.hidden)).toEqual([true, false, true]);

    undo();
    expect(inputs.every((i) => !i.hidden)).toBe(true);
    expect(document.querySelector(".ab-wizard-nav")).toBeNull();
  });
});
