/**
 * Percentiles, and nothing else.
 *
 * There is deliberately no budget here and no assertion on any number this
 * file produces. A threshold nobody chose is a threshold that gets deleted the
 * first time it fails, and a latency floor invented by the person writing the
 * load test is exactly that. The scenario asserts correctness under load and
 * *reports* the timings; `LOAD.md` is where a number becomes a claim, and it
 * says what the number does and does not mean.
 */

export interface Summary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * Nearest-rank, on the sorted sample. With 100 samples p99 is the 99th of 100 —
 * one observation. That is not a defect to be smoothed over with interpolation;
 * it is what a p99 from a hundred samples is worth, and stating the count
 * beside it is the honest way to present it.
 */
export function summarise(samples: readonly number[]): Summary {
  if (samples.length === 0) {
    throw new Error("A summary of no samples would be a made-up number.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (quantile: number): number => {
    const rank = Math.ceil(quantile * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
  };
  return {
    count: sorted.length,
    min: sorted[0] as number,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) as number,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

const round = (value: number): string => value.toFixed(1);

export function table(rows: readonly (readonly [string, Summary])[]): string {
  const header =
    "| measurement | n | min | p50 | p95 | p99 | max | mean |\n" +
    "|---|---:|---:|---:|---:|---:|---:|---:|";
  const body = rows.map(
    ([name, summary]) =>
      `| ${name} | ${summary.count} | ${round(summary.min)} | ${round(summary.p50)} | ` +
      `${round(summary.p95)} | ${round(summary.p99)} | ${round(summary.max)} | ` +
      `${round(summary.mean)} |`,
  );
  return [header, ...body].join("\n");
}
