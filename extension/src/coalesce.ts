export type CoalescePhase = "idle" | "running" | "running-dirty";

export function settle<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    work.then(
      (value) => finish(value),
      () => finish(fallback),
    );
  });
}

export function createCoalescer(timeoutMs = 8_000) {
  let phase: CoalescePhase = "idle";
  let task: ((current: () => boolean) => Promise<void>) | null = null;
  let generation = 0;

  const start = (next: (current: () => boolean) => Promise<void>) => {
    task = next;
    if (phase === "idle") {
      phase = "running";
      void pump();
      return;
    }
    generation += 1;
    phase = "running-dirty";
  };

  const pump = async () => {
    const run = task;
    const token = ++generation;
    const current = () => generation === token;
    try {
      if (run) await settle(Promise.resolve().then(() => run(current)), undefined, timeoutMs);
    } finally {
      generation += 1;
      if (phase === "running-dirty") {
        phase = "running";
        void pump();
      } else {
        phase = "idle";
      }
    }
  };

  return { start, phase: () => phase };
}

export function paintOnce(task: (current: () => boolean) => Promise<void>, timeoutMs = 8_000): () => void {
  const runner = createCoalescer(timeoutMs);
  return () => runner.start(task);
}
