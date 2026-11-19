/**
 * Small deterministic PRNG (mulberry32). The same seed always produces the
 * same dataset, which keeps tests, evals and README examples reproducible.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Approximately normal noise around 1 (sum of uniforms), clamped to stay positive. */
  noise(spread: number): number {
    const n = (this.next() + this.next() + this.next() - 1.5) / 1.5;
    return Math.max(0.05, 1 + n * spread);
  }

  /** Poisson-distributed integer (Knuth for small means, normal approximation above). */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean > 60) {
      const u = Math.max(this.next(), Number.EPSILON);
      const v = this.next();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return Math.max(0, Math.round(mean + z * Math.sqrt(mean)));
    }
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Cannot pick from an empty list');
    return item;
  }

  /** Pick an item with probability proportional to its weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    const last = items[items.length - 1];
    if (last === undefined) throw new Error('Cannot pick from an empty list');
    return last[0];
  }
}
