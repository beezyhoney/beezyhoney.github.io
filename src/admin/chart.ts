// Maths for the inline SVG bar chart (components/BarChart.astro). No chart library.

/** A "nice" top for the scale: the smallest of 1, 2, 2.5, 5 × 10^k that is ≥ max (0 → 0). */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    const v = step * base;
    if (v >= max - 1e-9 * base) return v;
  }
  return 10 * base;
}

/** Show every k-th label so at most `maxLabels` are visible (the last label is always kept). */
export function labelStep(count: number, maxLabels: number): number {
  if (count <= 0 || maxLabels <= 0) return 1;
  return Math.max(1, Math.ceil(count / maxLabels));
}

/**
 * Which label indexes to show for a step: 0, k, 2k, … and always the last one. A shown label closer to the last one
 * than max(2, step/2) slots is dropped, so the two never touch (12 months, step 2 → 0,2,4,6,8,11).
 */
export function visibleLabels(count: number, step: number): Set<number> {
  const shown = new Set<number>();
  for (let i = 0; i < count; i += step) shown.add(i);
  if (count > 0) {
    const last = count - 1;
    if (!shown.has(last)) {
      const prev = last - (last % step);
      if (step > 1 && last - prev < Math.max(2, Math.ceil(step / 2))) shown.delete(prev);
      shown.add(last);
    }
  }
  return shown;
}

export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bars in a viewBox `count*slot` wide and `height` tall. Negative values are drawn as 0. A value above zero is at
 * least `minH` tall so small days stay visible.
 */
export function bars(values: readonly number[], opts: { slot?: number; gap?: number; height?: number; top?: number; minH?: number } = {}): { bars: Bar[]; max: number; width: number } {
  const slot = opts.slot ?? 10;
  const gap = opts.gap ?? 2.5;
  const height = opts.height ?? 100;
  const minH = opts.minH ?? 1;
  const max = opts.top ?? niceMax(Math.max(0, ...values.map((v) => (Number.isFinite(v) ? v : 0))));
  const out = values.map((raw, i) => {
    const v = Number.isFinite(raw) && raw > 0 ? raw : 0;
    let h = max > 0 ? (v / max) * height : 0;
    if (v > 0 && h < minH) h = minH;
    h = Math.min(h, height);
    return { x: i * slot + gap / 2, y: height - h, w: slot - gap, h };
  });
  return { bars: out, max, width: values.length * slot };
}
