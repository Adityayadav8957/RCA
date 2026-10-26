export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);

export function percentile(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
export const median = (a: number[]) => percentile(a, 50);

/** Median absolute deviation, scaled (x1.4826) so it is comparable to a standard deviation for normal data. */
export function mad(a: number[]): number {
  if (!a.length) return 0;
  const m = median(a);
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Union length of [start,end] intervals, clipped to [lo,hi]. Handles overlapping (parallel) intervals. */
export function unionLength(intervals: Array<[number, number]>, lo: number, hi: number): number {
  const iv = intervals
    .map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of iv) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curE > curS) total += curE - curS;
  return total;
}
