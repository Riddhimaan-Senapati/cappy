import type { BlockOf } from "@browser-agent/shared";
import { Journal } from "./journal";

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SKIPPED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const ERROR_CLASS = "ab-field-error";
const ERROR_STYLE = "color:#b00020;font-weight:600;margin:4px 0;";

export function applyFormFixer(cfg: BlockOf<"form_fixer">, doc: Document = document): () => void {
  const journal = new Journal();
  try {
    sizeTargets(doc, cfg.minTargetPx, journal);
    if (cfg.addLabels) addMissingLabels(doc, journal);
    if (cfg.clearErrors) watchErrors(doc, journal);
    fixTabOrder(doc, journal);
    if (cfg.oneQuestionMode) {
      for (const form of Array.from(doc.forms)) oneQuestionAtATime(form, doc, journal);
    }
  } catch (err) {
    journal.unwind();
    throw err;
  }
  return () => journal.unwind();
}

function isField(el: Element | null): el is Field {
  if (!el) return false;
  if (el.tagName === "INPUT") return !SKIPPED_INPUT_TYPES.has((el as HTMLInputElement).type);
  return el.tagName === "SELECT" || el.tagName === "TEXTAREA";
}

function fieldsIn(root: ParentNode): Field[] {
  return Array.from(root.querySelectorAll("input, select, textarea")).filter(isField);
}

function uniqueId(doc: Document, prefix: string): string {
  let n = 1;
  while (doc.getElementById(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function sizeTargets(doc: Document, px: number, journal: Journal): void {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("form input, form select, form textarea, form button"))) {
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") continue;
    journal.touch(el);
    el.style.minHeight = `${px}px`;
    el.style.minWidth = `${px}px`;
  }
}

function hasAccessibleName(field: Field, doc: Document): boolean {
  if (field.getAttribute("aria-label")?.trim()) return true;
  if (field.getAttribute("aria-labelledby")?.trim()) return true;
  const wrapper = field.closest("label");
  if (wrapper?.textContent?.trim()) return true;
  return labelsFor(field, doc).some((label) => label.textContent?.trim());
}

function labelsFor(field: Field, doc: Document): HTMLLabelElement[] {
  if (!field.id) return [];
  return Array.from(doc.querySelectorAll("label[for]")).filter(
    (label): label is HTMLLabelElement => label.getAttribute("for") === field.id,
  );
}

function humanize(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function deriveLabelText(field: Field): string {
  const placeholder = field.getAttribute("placeholder")?.trim();
  if (placeholder) return placeholder;
  const title = field.getAttribute("title")?.trim();
  if (title) return title;
  const source = field.getAttribute("name")?.trim() || field.id.trim();
  return source ? humanize(source) : "";
}

function addMissingLabels(doc: Document, journal: Journal): void {
  for (const field of fieldsIn(doc)) {
    if (hasAccessibleName(field, doc)) continue;
    const text = deriveLabelText(field);
    if (!text) continue;

    if (!field.id) {
      journal.touch(field);
      field.id = uniqueId(doc, "ab-field");
    }
    const label = doc.createElement("label");
    label.setAttribute("for", field.id);
    label.textContent = text;
    field.before(label);
    journal.add(() => label.remove());
  }
}

function watchErrors(doc: Document, journal: Journal): void {
  const shown = new Map<Field, HTMLElement>();

  const show = (field: Field): void => {
    if (shown.has(field)) return;
    const id = uniqueId(doc, "ab-error");
    const message = doc.createElement("p");
    message.id = id;
    message.className = ERROR_CLASS;
    message.setAttribute("role", "alert");
    message.setAttribute("style", ERROR_STYLE);
    message.textContent = field.validationMessage || "This field is required";

    journal.touch(field);
    const described = field.getAttribute("aria-describedby");
    field.setAttribute("aria-describedby", [described, id].filter(Boolean).join(" "));
    field.setAttribute("aria-invalid", "true");
    field.after(message);
    shown.set(field, message);
  };

  const hide = (field: Field): void => {
    const message = shown.get(field);
    if (!message) return;
    message.remove();
    shown.delete(field);
    const remaining = (field.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((ref) => ref && ref !== message.id);
    if (remaining.length > 0) field.setAttribute("aria-describedby", remaining.join(" "));
    else field.removeAttribute("aria-describedby");
    field.removeAttribute("aria-invalid");
  };

  const sync = (field: Field): void => {
    if (field.checkValidity()) hide(field);
    else show(field);
  };

  const onInvalid = (event: Event): void => {
    if (isField(event.target as Element)) show(event.target as Field);
  };
  const onFocusOut = (event: Event): void => {
    if (isField(event.target as Element)) sync(event.target as Field);
  };
  const onInput = (event: Event): void => {
    const target = event.target as Element;
    if (isField(target) && target.checkValidity()) hide(target);
  };
  const onSubmit = (event: Event): void => {
    const form = event.target as Element;
    if (form.tagName !== "FORM") return;
    for (const field of fieldsIn(form)) {
      if (!field.checkValidity()) show(field);
    }
  };

  doc.addEventListener("invalid", onInvalid, true);
  doc.addEventListener("focusout", onFocusOut, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("submit", onSubmit, true);
  journal.add(() => {
    doc.removeEventListener("invalid", onInvalid, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("submit", onSubmit, true);
    for (const message of shown.values()) message.remove();
    shown.clear();
  });
}

function fixTabOrder(doc: Document, journal: Journal): void {
  for (const el of Array.from(doc.querySelectorAll("[tabindex]"))) {
    const index = Number.parseInt(el.getAttribute("tabindex") ?? "", 10);
    if (!(index > 0)) continue;
    journal.touch(el);
    el.removeAttribute("tabindex");
  }
}

function groupOf(field: Field, doc: Document): HTMLElement[] {
  const group: HTMLElement[] = [];
  const wrapper = field.closest("label");
  if (wrapper) group.push(wrapper);
  else group.push(field);
  for (const label of labelsFor(field, doc)) if (!group.includes(label)) group.push(label);
  for (const ref of (field.getAttribute("aria-describedby") ?? "").split(/\s+/)) {
    const message = ref ? doc.getElementById(ref) : null;
    if (message?.classList.contains(ERROR_CLASS) && !group.includes(message)) group.push(message);
  }
  return group;
}

function oneQuestionAtATime(form: HTMLFormElement, doc: Document, journal: Journal): void {
  const fields = fieldsIn(form);
  if (fields.length < 2) return;

  const controls = Array.from(
    form.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="image"], input[type="reset"]'),
  );
  for (const el of [...controls, ...fields.flatMap((f) => groupOf(f, doc))]) journal.touch(el);
  for (const el of controls) el.hidden = true;

  const nav = doc.createElement("div");
  nav.className = "ab-wizard-nav";
  const back = doc.createElement("button");
  back.type = "button";
  back.textContent = "Back";
  const next = doc.createElement("button");
  next.type = "button";
  nav.append(back, next);
  form.append(nav);
  journal.add(() => nav.remove());

  let index = 0;
  const render = (): void => {
    fields.forEach((field, i) => {
      for (const el of groupOf(field, doc)) el.hidden = i !== index;
    });
    const last = index === fields.length - 1;
    back.disabled = index === 0;
    next.textContent = last ? "Submit" : "Next";
    next.disabled = !fields[index]?.checkValidity();
  };

  back.addEventListener("click", () => {
    if (index > 0) index--;
    render();
  });
  next.addEventListener("click", () => {
    if (index < fields.length - 1) {
      index++;
      render();
    } else {
      form.requestSubmit();
    }
  });
  const onFieldChange = (): void => render();
  form.addEventListener("input", onFieldChange);
  form.addEventListener("change", onFieldChange);
  journal.add(() => {
    form.removeEventListener("input", onFieldChange);
    form.removeEventListener("change", onFieldChange);
  });

  render();
}
