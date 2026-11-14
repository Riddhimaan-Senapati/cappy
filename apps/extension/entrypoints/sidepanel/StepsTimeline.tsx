import { useEffect, useState } from "react";
import { STEPS_KEY, parseSteps, runsNewestFirst, type Step, type Tone } from "../../utils/steps";

const TONE_LABELS: Record<Tone, string> = {
  info: "Note",
  good: "Done",
  warn: "Check",
  bad: "Problem",
};

const TONE_GLYPHS: Record<Tone, string> = {
  info: "•",
  good: "✓",
  warn: "!",
  bad: "✕",
};

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function useSteps() {
  const [state, setState] = useState(parseSteps(undefined));
  useEffect(() => {
    let alive = true;
    void chrome.storage.session.get(STEPS_KEY).then((stored: Record<string, unknown>) => {
      if (alive) setState(parseSteps(stored[STEPS_KEY]));
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && STEPS_KEY in changes) setState(parseSteps(changes[STEPS_KEY]?.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return state;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function StepsTimeline() {
  const state = useSteps();
  const now = useNow(15_000);
  const runs = runsNewestFirst(state);

  return (
    <section className="card timeline" aria-labelledby="h-what-the-agent-did">
      <h2 id="h-what-the-agent-did">What the agent did</h2>
      {runs.length === 0 && <p className="muted">Steps appear here as the agent reads, changes and checks a page.</p>}
      {runs.map((run, index) => (
        <div className="timeline-run" key={run.runId}>
          <h3 className="timeline-run-title">{index === 0 ? "Latest change" : "Earlier change"}</h3>
          <ol className="timeline-steps" aria-live="polite" aria-relevant="additions">
            {run.steps.map((step) => (
              <StepItem key={step.id} step={step} now={now} />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

function StepItem({ step, now }: { step: Step; now: number }) {
  return (
    <li className={`timeline-step tone-${step.tone}`}>
      <span className="timeline-glyph" aria-hidden="true">
        {TONE_GLYPHS[step.tone]}
      </span>
      <span className="timeline-label">{TONE_LABELS[step.tone]}:</span> <span className="timeline-text">{step.text}</span>{" "}
      <time className="timeline-time" dateTime={new Date(step.at).toISOString()}>
        {relativeTime(step.at, now)}
      </time>
    </li>
  );
}
