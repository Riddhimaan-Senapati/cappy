import type axe from "axe-core";
import type { BlockCall } from "../../../shared/adaptation.js";
import { accessibleName, isVisible, LABELLABLE, OWN_ATTR, queryAll } from "./dom.js";

type FormFixer = Extract<BlockCall, { name: "formFixer" }>;

// axe-core is ~650 KB, so it is injected only when a form change needs its audit.
async function loadAxe(): Promise<typeof axe> {
  const scope = globalThis as unknown as { __cappyAxe?: typeof axe };
  if (!scope.__cappyAxe) {
    const loaded = (await chrome.runtime.sendMessage({ kind: "loadAxe" }).catch(() => undefined)) as { ok?: boolean } | undefined;
    if (!loaded?.ok || !scope.__cappyAxe) throw new Error("axe-core is unavailable");
  }
  return scope.__cappyAxe;
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Undo = () => void;

const CONTROLS = 'form :is(input:not([type="hidden"]), select, textarea, button)';
const FIELDS = `form :is(${LABELLABLE})`;
const SUBMIT = 'button:not([type]), button[type="submit"], input[type="submit"]';
const SIMPLE = 'input:not([type]), input:is([type="text"], [type="email"], [type="tel"], [type="url"], [type="number"], [type="search"], [type="date"]), select:not([multiple]), textarea';
let nextId = 0;
let auditQueue = Promise.resolve("");

function uniqueId(prefix: string): string {
  let id: string;
  do {
    id = `ba-${prefix}-${++nextId}`;
  } while (document.getElementById(id));
  return id;
}

function addLabel(field: Field, undo: Undo[]) {
  if (accessibleName(field)) return;
  const next = field.nextElementSibling;
  const caption = field.matches('input:is([type="checkbox"], [type="radio"])') &&
    next?.matches("span, small, b, strong, em") &&
    !next.querySelector("a, button, input, select, textarea, [tabindex]") && next.textContent?.trim();
  const placeholderOption = field instanceof HTMLSelectElement && field.options[0]?.value === "" ? field.options[0].text : "";
  const name = (field.name || field.id).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim();
  const text = (caption || field.getAttribute("placeholder")?.trim() || placeholderOption || name).trim().slice(0, 120);
  if (!text) return;

  const oldId = field.getAttribute("id");
  const needsId = !oldId || document.getElementById(oldId) !== field;
  const label = document.createElement("label");
  label.setAttribute(OWN_ATTR, "form-label");
  if (needsId) field.id = uniqueId("field");
  const id = field.id;
  label.htmlFor = id;
  if (caption && next) {
    next.before(label);
    label.append(next);
  } else {
    label.textContent = text[0].toUpperCase() + text.slice(1);
    field.before(label);
  }
  undo.push(() => {
    if (caption && next?.parentNode === label) label.before(next);
    label.remove();
    if (needsId && field.id === id) {
      if (oldId === null) field.removeAttribute("id");
      else field.id = oldId;
    }
  });
}

function explainErrors(undo: Undo[]) {
  const shown = new Map<Field, { node: HTMLElement; original: string | null }>();
  function hide(field: Field) {
    const error = shown.get(field);
    if (!error) return;
    error.node.remove();
    shown.delete(field);
    const description = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== error.node.id).join(" ");
    if (description) field.setAttribute("aria-describedby", description);
    else if (error.original === "") field.setAttribute("aria-describedby", "");
    else field.removeAttribute("aria-describedby");
  }
  function update(event: Event) {
    if (!(event.target instanceof Element) || !event.target.matches(FIELDS)) return;
    const field = event.target as Field;
    const current = shown.get(field);
    if (field.validity.valid || !field.willValidate) {
      hide(field);
      return;
    }
    if (current) {
      current.node.textContent = field.validationMessage;
      return;
    }
    if (event.type === "input") return;
    const message = document.createElement("span");
    message.id = uniqueId("form-error");
    message.setAttribute(OWN_ATTR, "form-error");
    message.setAttribute("role", "alert");
    message.textContent = field.validationMessage;
    const original = field.getAttribute("aria-describedby");
    field.setAttribute("aria-describedby", [original, message.id].filter(Boolean).join(" "));
    field.after(message);
    shown.set(field, { node: message, original });
  }
  const events = ["invalid", "focusout", "input"];
  events.forEach((event) => document.addEventListener(event, update, true));
  undo.push(() => {
    events.forEach((event) => document.removeEventListener(event, update, true));
    for (const field of shown.keys()) hide(field);
  });
}

function oneQuestionAtATime(form: HTMLFormElement, fields: Field[], undo: Undo[]) {
  const submit = [...form.querySelectorAll<HTMLElement>(SUBMIT)].filter(isVisible);
  if (fields.length < 2 || submit.length !== 1 || fields.some((field) => !field.matches(SIMPLE) || field.matches(":disabled") || !field.labels?.length)) return;
  if ([...form.elements].some((element) => !fields.includes(element as Field) && !submit.includes(element as HTMLElement) && !element.matches('fieldset, input[type="hidden"]'))) return;
  const groups = fields.map((field) => [field, ...Array.from(field.labels ?? [])]);
  const elements = [...groups.flat(), ...submit];
  if (new Set(elements).size !== elements.length || elements.some((element) => element.closest("[hidden]") || !form.contains(element))) return;
  const hiddenAttribute = "data-ba-form-step-hidden";
  const previous = new Map(elements.map((element) => [element, element.getAttribute(hiddenAttribute)]));

  const nav = document.createElement("div");
  nav.setAttribute(OWN_ATTR, "form-nav");
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back";
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next";
  nav.append(back, next);
  form.append(nav);

  let step = 0;
  const render = (focus: boolean) => {
    groups.forEach((group, index) => group.forEach((element) => {
      element.toggleAttribute(hiddenAttribute, index !== step);
    }));
    submit[0].toggleAttribute(hiddenAttribute, step < groups.length - 1);
    back.disabled = step === 0;
    next.hidden = step === groups.length - 1;
    if (focus) fields[step].focus();
  };
  function advance() {
    if (step < groups.length - 1 && fields[step].reportValidity()) {
      step++;
      render(true);
    }
  }
  back.addEventListener("click", () => {
    if (step > 0) step--;
    render(true);
  });
  next.addEventListener("click", advance);
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.isComposing || event.target !== fields[step] || step === groups.length - 1 || fields[step].matches("textarea, select")) return;
    event.preventDefault();
    advance();
  }
  function onInvalid(event: Event) {
    const invalidStep = fields.indexOf(event.target as Field);
    if (invalidStep >= 0 && invalidStep < step) {
      step = invalidStep;
      render(true);
    }
  }
  form.addEventListener("keydown", onKeyDown);
  form.addEventListener("invalid", onInvalid, true);
  undo.push(() => {
    form.removeEventListener("keydown", onKeyDown);
    form.removeEventListener("invalid", onInvalid, true);
    nav.remove();
    for (const [element, value] of previous) {
      if (value === null) element.removeAttribute(hiddenAttribute);
      else element.setAttribute(hiddenAttribute, value);
    }
  });
  render(false);
}

export function applyFormFixer(block: FormFixer) {
  const undo: Undo[] = [];
  const restore = () => undo.splice(0).reverse().forEach((step) => step());
  const controls = (queryAll(CONTROLS) as HTMLElement[]).filter(isVisible);
  const fields = controls.filter((element): element is Field => element.matches(LABELLABLE));
  if (!controls.length) return { undo: restore, matched: () => 0 };

  try {
    const style = document.createElement("style");
    style.setAttribute(OWN_ATTR, "form-fixer");
    style.textContent = `
${CONTROLS} { min-width: ${block.minTargetPx}px !important; min-height: ${block.minTargetPx}px !important; }
[data-ba="form-label"], [data-ba="form-error"] { display: block; font-size: max(1em, 16px); font-weight: 600; }
[data-ba="form-nav"] button { min-width: ${block.minTargetPx}px; min-height: ${block.minTargetPx}px; }
[data-ba-form-step-hidden], [data-ba="form-nav"] button[hidden] { display: none !important; }
`;
    document.documentElement.append(style);
    undo.push(() => style.remove());
    for (const control of controls) {
      if (control.tabIndex <= 0) continue;
      const previous = control.getAttribute("tabindex")!;
      control.removeAttribute("tabindex");
      undo.push(() => {
        if (!control.hasAttribute("tabindex")) control.setAttribute("tabindex", previous);
      });
    }
    if (block.addLabels) fields.forEach((field) => addLabel(field, undo));
    if (block.clearErrors) explainErrors(undo);
    if (block.oneQuestionMode) {
      for (const form of document.forms) oneQuestionAtATime(form, fields.filter((field) => field.form === form), undo);
    }
  } catch (error) {
    restore();
    throw error;
  }
  const note = auditQueue.then(async () => {
    if (!undo.length) return "";
    const results = await loadAxe().then((engine) => engine.run({ include: ["form"] }, {
      runOnly: { type: "rule", values: ["label", "select-name", "tabindex"] },
      resultTypes: ["violations"],
      iframes: false,
      preload: false,
    }));
    const count = results.violations.reduce((total, rule) => total + rule.nodes.length, 0);
    return `Axe checked visible form labels and tab order. ${count} issue${count === 1 ? "" : "s"} remain${count === 1 ? "s" : ""}.`;
  }).catch(() => "The form audit was unavailable. Check the page stats for the result.");
  auditQueue = note;
  return { undo: restore, matched: () => controls.length, note };
}
