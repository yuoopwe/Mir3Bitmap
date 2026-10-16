/**
 * Health over the last moments, from the game's memory (a reading every 50 ms): how fast it's falling, and where it
 * will be shortly if it goes on so. Potions and getting away go by where health is heading, not only where it is:
 * by the time a blow-by-blow fall crosses the line, the next blow can already be on its way. Pure: no game.
 */

/** Every number the trend goes by. */
export const TREND = {
  /** The readings the fall is worked out over (the last this long). */
  windowMs: 1500,
  /** Fewer readings, or a shorter stretch, than these say nothing yet. */
  minSamples: 3,
  minSpanMs: 400,
};

export class HealthTrend {
  /** Health (a share of the most) at each reading's time, oldest first. */
  private samples: { at: number; share: number }[] = [];

  /** A reading's health, at `at` (ms). */
  add(at: number, share: number): void {
    // Back from the dead, or a reading out of order: start afresh.
    if (this.samples.length && at < this.samples[this.samples.length - 1].at) this.samples = [];
    this.samples.push({ at, share });
    while (this.samples.length && at - this.samples[0].at > TREND.windowMs) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  /** Health lost a second (a share of the most) over the last readings: the least-squares slope, 0 unless falling. */
  fallPerSecond(): number {
    const n = this.samples.length;
    if (n < TREND.minSamples || this.samples[n - 1].at - this.samples[0].at < TREND.minSpanMs) return 0;
    const meanAt = this.samples.reduce((s, p) => s + p.at, 0) / n;
    const meanShare = this.samples.reduce((s, p) => s + p.share, 0) / n;
    let num = 0, den = 0;
    for (const p of this.samples) {
      num += (p.at - meanAt) * (p.share - meanShare);
      den += (p.at - meanAt) ** 2;
    }
    const slope = den > 0 ? (num / den) * 1000 : 0;
    return slope < 0 ? -slope : 0;
  }

  /** Health `aheadMs` from the last reading if it goes on falling as it has (never above where it is); null with no readings. */
  ahead(aheadMs: number): number | null {
    const last = this.samples[this.samples.length - 1];
    if (!last) return null;
    return Math.max(0, last.share - (this.fallPerSecond() * aheadMs) / 1000);
  }
}
