// One Euro filter: smooths jitter when the hand is still and stays responsive when it moves fast.
export class OneEuroFilter {
  private value: number | undefined;
  private derivative = 0;
  private time: number | undefined;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.008,
    private derivativeCutoff = 1,
  ) {}

  reset() {
    this.value = undefined;
    this.time = undefined;
    this.derivative = 0;
  }

  filter(input: number, timeMs: number): number {
    if (this.value === undefined || this.time === undefined) {
      this.value = input;
      this.time = timeMs;
      return input;
    }
    const dt = Math.max(1e-3, (timeMs - this.time) / 1000);
    this.time = timeMs;
    const alpha = (cutoff: number) => {
      const r = 2 * Math.PI * cutoff * dt;
      return r / (r + 1);
    };
    this.derivative += alpha(this.derivativeCutoff) * ((input - this.value) / dt - this.derivative);
    this.value += alpha(this.minCutoff + this.beta * Math.abs(this.derivative)) * (input - this.value);
    return this.value;
  }
}
