import { Fragment, useEffect, useRef } from "react";
import type { Proposal } from "@browser-agent/companion";
import { KEYS, type LastResult } from "../../utils/state";
import { EMPTY_STEPS, STEPS_KEY, parseSteps, type Run, type Step, type Tone } from "../../utils/steps";
import { KIND_LABELS } from "./ProfileEditor";
import { VerifyPanel } from "./VerifyPanel";
import { parseLast, useNow, useStored } from "./hooks";

export type Entry = { id: string; role: "user" | "agent" | "system"; text: string; at: number };

const TONE_LABELS: Record<Tone, string> = { info: "Note", good: "Done", warn: "Check", bad: "Problem" };
const TONE_GLYPHS: Record<Tone, string> = { info: "•", good: "✓", warn: "!", bad: "✕" };

type Props = {
  entries: Entry[];
  proposal: Proposal | null;
  busy: boolean;
  onDecide: (accept: boolean) => void;
};

// One conversation: chat entries and each agent run are interleaved by time, so a run sits under the message that asked for it.
export function ChatLog({ entries, proposal, busy, onDecide }: Props) {
  const runs = (useStored("session", STEPS_KEY, parseSteps) ?? EMPTY_STEPS).runs;
  const last = useStored("session", KEYS.last, parseLast);
  const now = useNow(15_000);
  const logRef = useRef<HTMLDivElement>(null);

  const nodes = [
    ...entries.map((entry) => ({ at: entry.at, key: entry.id, node: <Bubble entry={entry} /> })),
    ...runs.map((run, index) => ({
      at: run.steps[0]?.at ?? 0,
      key: run.runId,
      node: <RunBubble run={run} now={now} latest={index === runs.length - 1} last={last} />,
    })),
  ].sort((a, b) => a.at - b.at);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries, runs, proposal]);

  return (
    <div className="log" role="log" aria-live="polite" aria-label="Conversation" ref={logRef}>
      {nodes.map((item) => (
        <Fragment key={item.key}>{item.node}</Fragment>
      ))}
      {proposal && <ProposalCard proposal={proposal} busy={busy} onDecide={onDecide} />}
    </div>
  );
}

function Bubble({ entry }: { entry: Entry }) {
  if (entry.role === "system") {
    return (
      <div className="bubble system">
        <p>{entry.text}</p>
      </div>
    );
  }
  const who = entry.role === "user" ? "You: " : "Agent: ";
  return (
    <div className={`bubble ${entry.role === "user" ? "user" : "assistant"}`}>
      <p>
        <span className="sr-only">{who}</span>
        {entry.text}
      </p>
    </div>
  );
}

function RunBubble({ run, now, latest, last }: { run: Run; now: number; latest: boolean; last: LastResult | undefined }) {
  const outcome = latest ? outcomeOf(last) : undefined;
  return (
    <div className="bubble assistant run">
      <p className="bubble-label">
        <span className="sr-only">Agent: </span>Agent steps
      </p>
      <ol className="steps" aria-label="Agent steps">
        {run.steps.map((step) => (
          <StepItem key={step.id} step={step} now={now} />
        ))}
      </ol>
      {outcome && <p className="outcome">{outcome}</p>}
      {latest && <VerifyPanel />}
    </div>
  );
}

function StepItem({ step, now }: { step: Step; now: number }) {
  return (
    <li className={`timeline-step tone-${step.tone}`}>
      <span className="timeline-glyph" aria-hidden="true">
        {TONE_GLYPHS[step.tone]}
      </span>
      <span className="timeline-label">{TONE_LABELS[step.tone]}:</span>{" "}
      <span className="timeline-text">{step.text}</span>{" "}
      <time className="timeline-time" dateTime={new Date(step.at).toISOString()}>
        {relativeTime(step.at, now)}
      </time>
    </li>
  );
}

function ProposalCard({ proposal, busy, onDecide }: { proposal: Proposal; busy: boolean; onDecide: (accept: boolean) => void }) {
  return (
    <div className="bubble assistant proposal" role="group" aria-label="Proposed change">
      <p>
        <strong>Proposed:</strong> add {KIND_LABELS[proposal.need.kind].toLowerCase()} need, {proposal.need.detail}.
      </p>
      <p className="muted">{proposal.why}</p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => onDecide(true)}>
          Accept
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => onDecide(false)}>
          Reject
        </button>
      </div>
    </div>
  );
}

function outcomeOf(last: LastResult | undefined): string | undefined {
  if (!last) return undefined;
  switch (last.status) {
    case "applied":
      return `Applied: ${last.reason}`;
    case "undone":
      return "Undone.";
    case "none":
      return `No change: ${last.reason}`;
    case "blocked":
      return `Blocked: ${last.reason}`;
    case "error":
      return `Could not adapt: ${last.message}`;
  }
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
