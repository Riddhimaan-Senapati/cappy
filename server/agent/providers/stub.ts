import type { ActiveChange, Change, PageOutline } from "../../../shared/adaptation.js";
import type { TargetElement, Trigger } from "../../../shared/protocol.js";
import type { AgentSession } from "../session.js";
import { tools, type AgentTool } from "../tools.js";
import type { AgentProvider } from "./types.js";

// Deterministic provider for offline runs and e2e tests. It drives the same tools as the real providers,
// so validateChange, the CSS scan and the injection block all still run.
export type StubCall =
  | { name: "apply_change"; input: { change: Change } }
  | { name: "remember"; input: { lines: string[]; scope: "site" | "everywhere" } }
  | { name: "offer_options"; input: { question: string; options: Array<{ label: string; request: string }> } };

export interface StubPlan {
  calls: StubCall[];
  reply: string;
}

export interface StubInput {
  target?: TargetElement;
  trigger: Trigger;
  message: string;
  profile: string[];
  page: PageOutline;
  active?: ActiveChange[];
  makeItWork?: boolean;
}

const BIGGER_TEXT = /\b(bigger|larger)\b[^.!?]*\btext\b|\btext\b[^.!?]*\b(bigger|larger)\b/i;
const DARK_MODE = /dark mode/i;
const INVERT = /\binvert\b/i;
const REMOVE = /\b(?:remove(?: all)?|hide)\s+(?:the\s+|all\s+)?([a-z][a-z-]{1,30})\b/i;
const COLORBLIND = /colou?r[- ]?blind/i;
const TARGETED = /\b(?:remove|hide|delete|red)\b/i;
const VAGUE = /^make (?:this|it|the page) easier(?: to (?:read|use|see))?[.!?]?$/i;
const PREFERENCE = /\bI (?:prefer|like|hate)\b/i;
const SITE_ONLY = /\b(?:only (?:on |for )?this (?:site|website|page)|(?:on |for )?this (?:site|website|page) only|(?:on|for) this (?:site|website|page))\b/i;
const SITE_PREFIX = /^On ([^\s:]+(?::\d+)?): /i;

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
      const restrictedTo = line.match(SITE_PREFIX)?.[1];
      if (restrictedTo && restrictedTo !== new URL(input.page.url).host) continue;
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

  if (input.trigger === "review") {
    const broken = input.active?.find((change) => change.id === "needs-fix");
    if (!broken) return { calls: [], reply: "" };
    const { appliedAt: _appliedAt, targetLabel: _targetLabel, ...change } = broken;
    return {
      calls: [{ name: "apply_change", input: { change: { ...change, summary: "Obscuring videos about gaming", css: "video { filter: blur(16px) !important; }", dom: null, block: null } } }],
      reply: "Identified an improvement. Improved the script.",
    };
  }

  const message = input.message.trim();
  if (input.makeItWork && /hide videos about gaming/i.test(message)) {
    const reason = `Request: "${message}"`;
    const literal = { ...filterChange("gaming", input.page, reason, false), id: "hide-gaming-videos", summary: "Hiding videos about gaming" };
    const improved = {
      ...literal,
      summary: "Obscuring videos about gaming",
      reason: `${reason} Hiding did not work, so the videos are dimmed instead.`,
      block: literal.block?.name === "contentFilter" ? { ...literal.block, action: "dim" as const } : literal.block,
    };
    return {
      calls: [
        { name: "apply_change", input: { change: literal } },
        { name: "apply_change", input: { change: improved } },
      ],
      reply: "Identified an improvement. Improved the script to obscure videos about gaming.",
    };
  }
  if (input.target && TARGETED.test(message)) {
    const { selector, label } = input.target;
    const red = /\bred\b/i.test(message);
    return {
      calls: [{ name: "apply_change", input: { change: change({
        id: red ? "target-red" : "target-hidden",
        summary: red ? `Made ${label} red` : `Hid ${label}`,
        reason: `Request: "${message.slice(0, 100)}"`,
        scope: "site",
        css: red ? `${selector} { color: #c00000 !important; }` : `${selector} { display: none !important; }`,
      }) } }],
      reply: red ? `Stub: made ${label} red.` : `Stub: hid ${label}.`,
    };
  }
  if (VAGUE.test(message)) {
    return {
      calls: [{ name: "offer_options", input: { question: "Which would help most?", options: [
        { label: "Larger text", request: "make the text bigger" },
        { label: "Dark mode", request: "turn on dark mode" },
        { label: "Hide clutter", request: "hide ads and popups" },
      ] } }],
      reply: "Pick the option that fits best, or edit one.",
    };
  }
  const reason = `Request: "${message.slice(0, 100)}"`;
  const siteOnly = SITE_ONLY.test(message);
  const preference = PREFERENCE.test(message);
  const scope = preference && !siteOnly ? "everywhere" : "site";
  const done: string[] = [];
  const remember = (line: string) => calls.push({ name: "remember", input: { lines: [line], scope: siteOnly ? "site" : "everywhere" } });

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
    // Mirrors the suggest contract: noticed zooming yields a larger-text suggestion, anything else NONE.
    async complete(_system: string, user: string) {
      const zooms = user.match(/- (?:zoom-in|pinch-zoom): here (\d+) \(10m\)/);
      if (!zooms) return "NONE";
      return JSON.stringify({ text: "make the text bigger", reason: `You zoomed in ${zooms[1]} times`, scope: "everywhere", memory: "Prefers larger text" });
    },
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
      const plan = planStubRun({ trigger, message, profile, page, active, target: session.request.target, makeItWork: session.request.makeItWork });
      const rejected: string[] = [];
      let applied = false;
      for (const call of plan.calls) {
        if (session.request.makeItWork && applied && call.name === "apply_change") await toolNamed("screenshot").run({}, session);
        const tool = toolNamed(call.name);
        if (call.name === "apply_change") applied = true;
        const result = await tool.run(tool.schema.parse(call.input), session);
        if (result.text.startsWith("REJECTED")) rejected.push(result.text);
        if (session.blockedReason) return "This page contains text that tries to instruct me, so I didn't change anything.";
      }
      if (rejected.length) return `Stub: the safety layer rejected a change. ${rejected[0]}`;
      return plan.reply;
    },
  };
}
