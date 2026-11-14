import type { ActiveChange, Change, PageOutline } from "../../../shared/adaptation.js";
import type { Trigger } from "../../../shared/protocol.js";
import type { AgentSession } from "../session.js";
import { tools, type AgentTool } from "../tools.js";
import type { AgentProvider } from "./types.js";

// Deterministic provider for offline runs and e2e tests. It drives the same tools as the real providers,
// so validateChange, the CSS scan and the injection block all still run.
export type StubCall =
  | { name: "apply_change"; input: { change: Change } }
  | { name: "remember"; input: { lines: string[] } };

export interface StubPlan {
  calls: StubCall[];
  reply: string;
}

export interface StubInput {
  trigger: Trigger;
  message: string;
  profile: string[];
  page: PageOutline;
  active?: ActiveChange[];
}

const BIGGER_TEXT = /\b(bigger|larger)\b[^.!?]*\btext\b|\btext\b[^.!?]*\b(bigger|larger)\b/i;
const DARK_MODE = /dark mode/i;
const INVERT = /\binvert\b/i;
const REMOVE = /\b(?:remove(?: all)?|hide)\s+(?:the\s+|all\s+)?([a-z][a-z-]{1,30})\b/i;
const COLORBLIND = /colou?r[- ]?blind/i;
const PREFERENCE = /\bI (?:prefer|like|hate)\b/i;
const SITE_ONLY = /\b(?:only (?:on |for )?this (?:site|website|page)|(?:on |for )?this (?:site|website|page) only|(?:on|for) this (?:site|website|page))\b/i;
const SITE_SUFFIX = / on (https?:\/\/[^ ]+)$/i;

const HELP = "Stub provider: no scripted rule matched. Try 'make the text bigger', 'dark mode', 'invert the colors', 'hide ads', 'I'm red-green colorblind', or 'I prefer ...'.";

function keywordForms(word: string): string[] {
  const forms = new Set([word]);
  if (word.endsWith("ies")) forms.add(`${word.slice(0, -3)}y`);
  else if (word.endsWith("s") && word.length > 2) forms.add(word.slice(0, -1));
  else forms.add(`${word}s`);
  return [...forms].filter((form) => form.length >= 2 && form.length <= 40);
}

function itemSelectorFor(page: PageOutline, forms: string[]): string | null {
  const hit = page.itemGroups.find((group) => group.samples.some((sample) => forms.some((form) => sample.toLowerCase().includes(form))));
  return hit?.selector ?? null;
}

function change(fields: Pick<Change, "id" | "summary" | "reason" | "scope"> & Partial<Pick<Change, "css" | "dom" | "block">>): Change {
  return { css: null, dom: null, block: null, ...fields };
}

function filterChange(word: string, page: PageOutline, reason: string, siteOnly: boolean): Change {
  const keywords = keywordForms(word);
  const itemSelector = itemSelectorFor(page, keywords);
  return change({
    id: `hide-${word}`,
    summary: `Hiding ${word}`,
    reason,
    scope: siteOnly || itemSelector ? "site" : "everywhere",
    block: { name: "contentFilter", keywords, itemSelector, action: "hide" },
  });
}

export function planStubRun(input: StubInput): StubPlan {
  const calls: StubCall[] = [];
  const origin = new URL(input.page.url).origin;

  if (input.trigger === "page_load") {
    for (const line of input.profile) {
      const restrictedTo = line.match(SITE_SUFFIX)?.[1];
      if (restrictedTo && restrictedTo !== origin) continue;
      const reason = `Profile: "${line}"`;
      const scope = restrictedTo ? "site" : "everywhere";
      const word = line.match(REMOVE)?.[1].toLowerCase();
      const adaptation = BIGGER_TEXT.test(line)
        ? change({ id: "bigger-text", summary: "Larger text (130%)", reason, scope, block: { name: "textScale", scale: 1.3 } })
        : DARK_MODE.test(line)
          ? change({ id: "dark-mode", summary: "Dark mode", reason, scope, block: { name: "darkMode", allowSiteControls: true } })
          : word
            ? filterChange(word, input.page, reason, Boolean(restrictedTo))
            : null;
      if (adaptation && !input.active?.some(({ id, block }) => id === adaptation.id || (adaptation.block?.name === "textScale" && block?.name === "textScale")) && !calls.some((call) => call.name === "apply_change" && call.input.change.id === adaptation.id)) {
        calls.push({ name: "apply_change", input: { change: adaptation } });
      }
    }
    const reply = calls.length === 1 && calls[0].name === "apply_change" && calls[0].input.change.id === "bigger-text"
      ? "Applied larger text from your profile."
      : calls.length ? "Applied your preferences." : "";
    return { calls, reply };
  }

  const message = input.message.trim();
  const reason = `Request: "${message.slice(0, 100)}"`;
  const siteOnly = SITE_ONLY.test(message);
  const preference = PREFERENCE.test(message);
  const scope = preference && !siteOnly ? "everywhere" : "site";
  const done: string[] = [];
  const remember = (line: string) => calls.push({ name: "remember", input: { lines: [siteOnly ? `${line} on ${origin}` : line] } });

  if (BIGGER_TEXT.test(message)) {
    calls.push({ name: "apply_change", input: { change: change({ id: "bigger-text", summary: "Larger text (130%)", reason, scope, block: { name: "textScale", scale: 1.3 } }) } });
    done.push("made the text larger");
  }

  if (DARK_MODE.test(message)) {
    calls.push({ name: "apply_change", input: { change: change({ id: "dark-mode", summary: "Dark mode", reason, scope, block: { name: "darkMode", allowSiteControls: true } }) } });
    done.push("turned on dark mode");
  }

  if (/\bmake this form easier\b/i.test(message)) {
    calls.push({
      name: "apply_change",
      input: { change: change({
        id: "easier-form", summary: "More accessible form", reason, scope: "site",
        block: { name: "formFixer", minTargetPx: 44, addLabels: true, clearErrors: true, oneQuestionMode: /one question at a time/i.test(message) },
      }) },
    });
    done.push("made the form easier to use");
  }

  if (INVERT.test(message)) {
    calls.push({ name: "apply_change", input: { change: change({ id: "invert-page", summary: "Inverted colors", reason, scope: "site", css: "html { filter: invert(1) hue-rotate(180deg); }" }) } });
    done.push("inverted the colors");
  }

  const removal = message.match(REMOVE);
  if (removal) {
    const word = removal[1].toLowerCase();
    calls.push({ name: "apply_change", input: { change: filterChange(word, input.page, reason, siteOnly) } });
    remember(`Hide ${word}`);
    done.push(`hid ${word}`);
  }

  if (COLORBLIND.test(message)) {
    calls.push({ name: "apply_change", input: { change: change({ id: "colorblind-deuteranopia", summary: "Red-green colorblind palette", reason, scope: siteOnly ? "site" : "everywhere", block: { name: "colorblind", type: "deuteranopia", scope: "media" } }) } });
    remember("Red-green colorblind");
    done.push("applied a red-green colorblind filter");
  }

  if (preference && !removal) {
    remember(message);
    done.push("saved that preference to your profile");
  }

  if (!done.length) return { calls, reply: HELP };
  return { calls, reply: `Stub: ${done.join(", ")}.` };
}

function toolNamed(name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Stub provider needs the ${name} tool`);
  return tool;
}

export function createStubProvider(): AgentProvider {
  return {
    name: "stub",
    models: { fast: "stub-fast", frontier: "stub-frontier" },
    async run(session: AgentSession) {
      const { trigger, message, profile, page, active } = session.request;

      await toolNamed("read_page").run({}, session);
      if (session.blockedReason) return "This page contains text that tries to instruct me, so I didn't change anything.";

      if (trigger === "chat" && /^turn on dark mode[.!?]?$/i.test(message.trim())) {
        const controls = await session.callTab("find_site_features", {});
        const toggle = controls.find((control) => control.kind === "toggle" && /^(?:toggle )?dark mode$/i.test(control.name));
        if (toggle) {
          const result = await toolNamed("use_site_control").run({
            controlId: toggle.id,
            value: true,
            summary: "Dark mode",
            reason: "Request: turn on dark mode",
          }, session);
          if (/"status":"(?:applied|already-set)"/.test(result.text)) return "Turned on the site's dark mode.";
        }
      }
      const plan = planStubRun({ trigger, message, profile, page, active });
      const rejected: string[] = [];
      for (const call of plan.calls) {
        const tool = toolNamed(call.name);
        const result = await tool.run(tool.schema.parse(call.input), session);
        if (result.text.startsWith("REJECTED")) rejected.push(result.text);
        if (session.blockedReason) return "This page contains text that tries to instruct me, so I didn't change anything.";
      }
      if (rejected.length) return `Stub: the safety layer rejected a change. ${rejected[0]}`;
      return plan.reply;
    },
  };
}
