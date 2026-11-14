import { useEffect, useState } from "react";
import { describeSchedule, isScheduleActive, type Rule } from "@browser-agent/shared";
import { loadClock, now } from "../../utils/clock";
import { RULES_KEY, loadRules, nextActiveAt, removeRule, saveRules, toggleRule } from "../../utils/rules";

export function RulesCard() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [at, setAt] = useState<Date>(() => now());

  useEffect(() => {
    let alive = true;
    const load = () => void loadRules().then((next) => alive && setRules(next));
    void loadClock().then(() => alive && setAt(now()));
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && RULES_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    const timer = setInterval(() => alive && setAt(now()), 30_000);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
      clearInterval(timer);
    };
  }, []);

  // Changes come from storage so the card and the background never disagree; each write reads first.
  const update = async (change: (current: Rule[]) => Rule[]) => {
    const next = change(await loadRules());
    await saveRules(next);
  };

  return (
    <section className="card rules" aria-labelledby="h-Your-rules">
      <h2 id="h-Your-rules">Your rules</h2>
      {rules.length === 0 ? (
        <p>
          Standing rules appear here. Ask for a change that should last, such as "hide podcasts on weekdays 9 to 5", and
          it will keep applying on its own.
        </p>
      ) : (
        <ul className="rules-list">
          {rules.map((rule) => (
            <li key={rule.id} className="rule">
              <p>
                <strong>{rule.text}</strong>
              </p>
              <p className="rule-meta">
                <span>{rule.everywhere ? "Everywhere" : rule.sites.join(", ")}</span>
                {" · "}
                <span>{describeSchedule(rule.filter.schedule) || "Always"}</span>
                {" · "}
                <span>{statusOf(rule, at)}</span>
              </p>
              <div className="row">
                <button
                  type="button"
                  aria-pressed={rule.enabled}
                  onClick={() => void update((current) => toggleRule(current, rule.id))}
                >
                  Enabled
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Delete rule: ${rule.text}`}
                  onClick={() => void update((current) => removeRule(current, rule.id))}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusOf(rule: Rule, at: Date): string {
  if (!rule.enabled) return "Turned off";
  if (isScheduleActive(rule.filter.schedule, at)) return "Active now";
  const next = nextActiveAt(rule.filter.schedule, at);
  return next ? `Paused until ${formatWhen(next)}` : "Ended";
}

function formatWhen(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
